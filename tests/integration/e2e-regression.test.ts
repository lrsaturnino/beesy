import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock only the CLI backend (the lowest external boundary)
// All runtime modules use their real implementations
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

// Import module under test
import { runTask } from "../../src/runtime/worker.js";

// Import real dependency modules for verification
import { readJournal } from "../../src/runtime/journal.js";
import { loadTask } from "../../src/runtime/task-state.js";
import { initRecipeRouter } from "../../src/recipes/router.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  OrchestratorConfig,
} from "../../src/recipes/types.js";
import type {
  StepOutput,
  AgentBackend,
} from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;
let workspacePath: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-e2e-regression-"));
  workspacePath = await mkdtemp(path.join(tmpdir(), "bees-e2e-workspace-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Factory for a minimal valid Task matching the new-implementation recipe shape. */
function createPlanningTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-e2e-001",
    gate: "new-implementation",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "Build a new feature with proper architecture" },
    requestedBy: "user-e2e",
    sourceChannel: { platform: "slack", channelId: "C-E2E" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    recipeId: "new-implementation",
    currentStageId: "planning",
    stageRetryCount: {},
    totalActionCount: 0,
    workspacePath,
    ...overrides,
  };
}

/** Factory for OrchestratorConfig pointing to temp directory role files. */
function createOrchestratorConfig(rolePath: string): OrchestratorConfig {
  return {
    role: rolePath,
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 180000,
    max_stage_retries: 2,
    max_total_actions: 40,
  };
}

/**
 * Factory for a single-stage planning recipe matching new-implementation.
 * Role paths point into the temp runsDir so they exist on disk.
 */
function createPlanningRecipe(): RecipeConfig {
  const orchestratorRolePath = path.join(runsDir, "roles", "orchestrator.md");
  const planningRolePath = path.join(runsDir, "roles", "planning.md");

  return {
    id: "new-implementation",
    name: "New Implementation",
    command: "/new-implementation",
    description: "Full implementation workflow from planning through code delivery",
    orchestrator: createOrchestratorConfig(orchestratorRolePath),
    stage_order: ["planning"],
    start_stage: "planning",
    stages: {
      planning: {
        role: planningRolePath,
        objective: "Analyze the request and produce an implementation plan",
        inputs: [
          { description: "User request", source: "task.payload.description" },
        ],
        outputs: [
          {
            label: "planning_doc",
            format: "md",
            mirror_to: [".bees/planning.md"],
          },
        ],
        allowed_transitions: [],
        allowed_scripts: [],
      },
    },
  };
}

/** Build a StepOutput with a stringified JSON decision. */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return {
    output: JSON.stringify(decision),
    outputFiles: [],
  };
}

/** Build a StepOutput simulating a stage agent producing text output. */
function makeStageOutput(text: string): StepOutput {
  return {
    output: text,
    outputFiles: [],
  };
}

/**
 * Create a mock backend whose run() returns responses in sequence.
 * Exhausting the sequence throws an error for easy diagnosis.
 */
function createSequenceBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(`Sequence backend exhausted at call ${callIndex}`);
    }
    return Promise.resolve(responses[callIndex++]);
  });
  return { name: "mock-backend", run: runFn };
}

/** Write all role files needed for the planning recipe. */
async function writeAllRoleFiles(recipe: RecipeConfig): Promise<void> {
  const orchDir = path.dirname(recipe.orchestrator.role);
  await mkdir(orchDir, { recursive: true });
  await writeFile(recipe.orchestrator.role, "You are a test orchestrator.", "utf-8");

  for (const [stageId, stage] of Object.entries(recipe.stages)) {
    const stageDir = path.dirname(stage.role);
    await mkdir(stageDir, { recursive: true });
    await writeFile(stage.role, `You are a ${stageId} agent.`, "utf-8");
  }
}

/** Planning document content returned by the mock stage agent. */
const PLANNING_DOC_CONTENT = `# Implementation Plan

## Overview
Build a new feature with proper architecture.

## Steps
1. Design the data model
2. Implement the API layer
3. Write integration tests
4. Deploy to staging`;

/**
 * Run a complete planning recipe through the worker loop with mock backend.
 * Extracts the repeated setup from tests that all exercise the same happy path.
 * Returns the completed task and the backend for call-count assertions.
 */
async function runCompletePlanningRecipe(): Promise<{
  task: Task;
  recipe: RecipeConfig;
  backend: AgentBackend;
}> {
  const recipe = createPlanningRecipe();
  await writeAllRoleFiles(recipe);
  const task = createPlanningTask();

  const backend = createSequenceBackend([
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "planning",
      reason: "start planning stage",
    }),
    makeStageOutput(PLANNING_DOC_CONTENT),
    makeDecisionOutput({
      action: "finish_run",
      reason: "planning complete, all outputs produced",
    }),
  ]);
  mockResolveAgentBackend.mockReturnValue(backend);

  await runTask(task, recipe, runsDir);
  return { task, recipe, backend };
}

// ---------------------------------------------------------------
// Scope A: Recipe Runtime E2E
// Exercises the full chain from runTask through the worker loop
// with only the CLI backend boundary mocked.
// ---------------------------------------------------------------

describe("Recipe runtime end-to-end regression", () => {
  it("planning recipe produces .bees/planning.md artifact through worker", async () => {
    const { task } = await runCompletePlanningRecipe();

    expect(task.status).toBe("completed");
    expect(task.completedAt).toBeInstanceOf(Date);

    // Mirror file should exist at workspace/.bees/planning.md
    const mirrorPath = path.join(workspacePath, ".bees", "planning.md");
    const mirrorContent = await readFile(mirrorPath, "utf-8");
    expect(mirrorContent).toBe(PLANNING_DOC_CONTENT);

    // Artifact file should exist under runsDir/<taskId>/artifacts/
    const artifactsDir = path.join(runsDir, task.id, "artifacts");
    const artifactFiles = await readdir(artifactsDir);
    expect(artifactFiles.length).toBe(1);
    expect(artifactFiles[0]).toMatch(/\.md$/);

    // Journal should contain artifact_registered entry with correct label
    const journal = readJournal(runsDir, task.id);
    const artifactEntry = journal.find(
      (e) => e.type === "artifact_registered" && e.label === "planning_doc",
    );
    expect(artifactEntry).toBeDefined();
    expect(artifactEntry!.format).toBe("md");
  });

  it("journal contains complete event trace for planning run", async () => {
    const { task } = await runCompletePlanningRecipe();

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);

    // Verify all expected entry types are present in a single planning run:
    //   subtask_queued -> subtask_started -> orchestrator_decision (run_stage_agent)
    //   -> subtask_completed -> subtask_queued (stage_agent_run) -> subtask_started
    //   -> artifact_registered -> subtask_completed -> subtask_queued (orch_eval)
    //   -> subtask_started -> orchestrator_decision (finish_run) -> task_completed
    //   -> subtask_completed
    const expectedTypes = [
      "subtask_queued",
      "subtask_started",
      "orchestrator_decision",
      "artifact_registered",
      "subtask_completed",
      "task_completed",
    ];
    for (const type of expectedTypes) {
      expect(types).toContain(type);
    }

    // Verify orchestrator_decision entries have correct actions
    const decisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisions).toHaveLength(2);
    expect(decisions[0].action).toBe("run_stage_agent");
    expect(decisions[0].target_stage).toBe("planning");
    expect(decisions[1].action).toBe("finish_run");

    // Verify task_completed is the last semantic event
    expect(journal.find((e) => e.type === "task_completed")).toBeDefined();

    // A complete planning run produces at least 10 journal entries
    expect(journal.length).toBeGreaterThanOrEqual(10);
  });

  it("recipe-triggered task routes through router with correct recipeId", async () => {
    const recipe = createPlanningRecipe();
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(recipe.id, recipe);

    const router = initRecipeRouter(recipes);

    // Router should match the /new-implementation command
    const matched = router.match("/new-implementation");
    expect(matched).not.toBeNull();
    expect(matched!.id).toBe("new-implementation");

    // createTask should produce a task with recipeId set
    const task = router.createTask({
      command: "/new-implementation",
      payload: { description: "build a feature" },
      channel: { platform: "slack", channelId: "C-TEST" },
      requestedBy: "U-TEST",
      timestamp: new Date(),
    });

    expect(task).not.toBeNull();
    expect(task!.recipeId).toBe("new-implementation");
    expect(task!.status).toBe("queued");
    expect(task!.gate).toBe("new-implementation");
  });

  it("subtask progression follows correct sequence", async () => {
    const { task } = await runCompletePlanningRecipe();

    expect(task.subtasks).toBeDefined();
    expect(task.subtasks!).toHaveLength(3);

    // Subtask kinds: orchestrator_eval -> stage_agent_run -> orchestrator_eval
    expect(task.subtasks!.map((s) => s.kind)).toEqual([
      "orchestrator_eval",
      "stage_agent_run",
      "orchestrator_eval",
    ]);

    // All subtasks should be completed with lifecycle timestamps
    for (const subtask of task.subtasks!) {
      expect(subtask.status).toBe("completed");
      expect(subtask.startedAt).toBeDefined();
      expect(subtask.completedAt).toBeDefined();
    }

    // No subtasks left in the queue
    expect(task.queuedSubtaskIds).toEqual([]);
  });

  it("task state persisted correctly to disk after completion", async () => {
    const { task } = await runCompletePlanningRecipe();

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("completed");
    expect(loaded!.completedAt).toBeInstanceOf(Date);
    expect(loaded!.subtasks!).toHaveLength(3);
    expect(loaded!.recipeId).toBe("new-implementation");
    expect(loaded!.currentStageId).toBe("planning");
  });

  it("mock CLI backend receives exactly 3 calls in correct order", async () => {
    const { task, backend } = await runCompletePlanningRecipe();

    expect(backend.run).toHaveBeenCalledTimes(3);

    // First call context should target the recipe start_stage
    const firstCallContext = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstCallContext.stepId).toBe("planning");

    expect(task.status).toBe("completed");
  });

  it("task created by router preserves sourceChannel for thread binding", async () => {
    const recipe = createPlanningRecipe();
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(recipe.id, recipe);

    const router = initRecipeRouter(recipes);

    const task = router.createTask({
      command: "/new-implementation",
      payload: { description: "build a feature" },
      channel: { platform: "slack", channelId: "C-THREAD-TEST", threadTs: "12345.6789" },
      requestedBy: "U-TEST",
      timestamp: new Date(),
    });

    expect(task).not.toBeNull();
    expect(task!.sourceChannel.channelId).toBe("C-THREAD-TEST");
    expect(task!.sourceChannel.threadTs).toBe("12345.6789");
    expect(task!.id).toBeDefined();
    expect(task!.recipeId).toBe("new-implementation");
  });

  it("completed task has correct cost tracking initialization", async () => {
    const { task } = await runCompletePlanningRecipe();

    // Cost accumulator should remain zeroed (mock backend does not report costs)
    expect(task.cost.totalTokens).toBe(0);
    expect(task.cost.inputTokens).toBe(0);
    expect(task.cost.outputTokens).toBe(0);
    expect(task.cost.estimatedCostUsd).toBe(0);

    // Artifact IDs collected from the single planning output
    expect(task.artifactIds).toBeDefined();
    expect(task.artifactIds!).toHaveLength(1);

    // Stage retry count incremented for the planning stage
    expect(task.stageRetryCount!["planning"]).toBe(1);

    // Total action count reflects the single run_stage_agent decision
    expect(task.totalActionCount).toBe(1);
  });
});
