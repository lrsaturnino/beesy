import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  OrchestratorConfig,
  StageDefinition,
  StageInput,
  StageOutput,
} from "../../src/recipes/types.js";
import type {
  StepOutput,
  AgentBackend,
} from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-orch-loop-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Factory for a minimal valid Task with recipe fields. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-int-001",
    gate: "test-gate",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "integration test project" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    recipeId: "integration-recipe",
    currentStageId: "planning",
    stageRetryCount: {},
    totalActionCount: 0,
    ...overrides,
  };
}

/** Factory for OrchestratorConfig. */
function createOrchestratorConfig(
  rolePath: string,
  overrides?: Partial<OrchestratorConfig>,
): OrchestratorConfig {
  return {
    role: rolePath,
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 120000,
    max_stage_retries: 3,
    max_total_actions: 50,
    ...overrides,
  };
}

/** Factory for a two-stage recipe used in integration tests. */
function createIntegrationRecipe(overrides?: Partial<RecipeConfig>): RecipeConfig {
  const orchestratorRolePath = path.join(runsDir, "roles", "orchestrator.md");
  const plannerRolePath = path.join(runsDir, "roles", "planner.md");
  const implementerRolePath = path.join(runsDir, "roles", "implementer.md");

  return {
    id: "integration-recipe",
    name: "Integration Recipe",
    command: "/integration",
    description: "Two-stage integration test recipe",
    orchestrator: createOrchestratorConfig(orchestratorRolePath),
    stage_order: ["planning", "implement"],
    start_stage: "planning",
    stages: {
      planning: {
        role: plannerRolePath,
        objective: "Create a detailed plan",
        inputs: [{ description: "Description", source: "task.payload.description" }],
        outputs: [{ label: "planning_doc", format: "md" }],
        allowed_transitions: ["implement"],
        allowed_scripts: [],
      },
      implement: {
        role: implementerRolePath,
        objective: "Implement the plan",
        inputs: [{ description: "Description", source: "task.payload.description" }],
        outputs: [{ label: "code", format: "ts" }],
        allowed_transitions: [],
        allowed_scripts: [],
      },
    },
    ...overrides,
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
 * Orchestrator decisions and stage outputs are interleaved in the
 * expected call order.
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

/** Write all role files needed for the integration recipe. */
async function writeAllRoleFiles(recipe: RecipeConfig): Promise<void> {
  // Orchestrator role
  const orchDir = path.dirname(recipe.orchestrator.role);
  await mkdir(orchDir, { recursive: true });
  await writeFile(recipe.orchestrator.role, "You are a test orchestrator.", "utf-8");

  // Stage roles
  for (const [stageId, stage] of Object.entries(recipe.stages)) {
    const stageDir = path.dirname(stage.role);
    await mkdir(stageDir, { recursive: true });
    await writeFile(stage.role, `You are a ${stageId} agent.`, "utf-8");
  }
}

// ---------------------------------------------------------------
// Integration: Full Orchestrator Loop
// ---------------------------------------------------------------

describe("Full Orchestrator Loop", () => {
  it("two-stage loop: planning -> implement -> finish", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);
    const task = createTestTask();

    // Sequence: orchestrator -> run planning -> planning agent -> orchestrator
    //        -> run implement -> implement agent -> orchestrator -> finish
    const backend = createSequenceBackend([
      // 1st orchestrator_eval: decide to run planning stage
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "planning", reason: "start planning" }),
      // planning stage_agent_run: produces plan
      makeStageOutput("Plan created: design document for widget"),
      // 2nd orchestrator_eval: decide to run implement stage
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "plan complete, implement" }),
      // implement stage_agent_run: produces code
      makeStageOutput("Code written: widget.ts with full implementation"),
      // 3rd orchestrator_eval: decide to finish
      makeDecisionOutput({ action: "finish_run", reason: "all stages complete" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Verify final state
    expect(task.status).toBe("completed");

    // Verify journal progression
    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);

    // Should have 3 orchestrator_decision entries
    const orchestratorDecisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(orchestratorDecisions.length).toBe(3);

    // Should have 2 stage_agent_run subtasks
    const stageSubtasks = task.subtasks!.filter((s) => s.kind === "stage_agent_run");
    expect(stageSubtasks.length).toBe(2);

    // Should have task_completed in journal
    expect(types).toContain("task_completed");

    // Verify the task was persisted to disk
    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("completed");
  });

  it("orchestrator loop with invalid decision recovery", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);
    const task = createTestTask();

    const backend = createSequenceBackend([
      // 1st orchestrator_eval: invalid decision (bad target_stage)
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "nonexistent_stage", reason: "wrong" }),
      // 2nd orchestrator_eval (re-invoked after rejection): valid planning
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "planning", reason: "corrected" }),
      // planning stage_agent_run
      makeStageOutput("Plan created after recovery"),
      // 3rd orchestrator_eval: finish
      makeDecisionOutput({ action: "finish_run", reason: "recovered and done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Task should complete despite the rejected decision
    expect(task.status).toBe("completed");

    // Journal should have the rejection
    const journal = readJournal(runsDir, task.id);
    const rejected = journal.filter((e) => e.type === "decision_rejected");
    expect(rejected.length).toBe(1);

    // Should also have valid orchestrator decisions after recovery
    const validDecisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(validDecisions.length).toBeGreaterThanOrEqual(2);
  });

  it("orchestrator loop ending in fail_run", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);
    const task = createTestTask();

    const backend = createSequenceBackend([
      // Orchestrator immediately fails the run
      makeDecisionOutput({ action: "fail_run", reason: "requirements unclear, cannot proceed" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("failed");
    expect(task.error).toContain("requirements unclear");

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("task_failed");

    // No stage_agent_run subtasks should have been created
    const stageSubtasks = task.subtasks!.filter((s) => s.kind === "stage_agent_run");
    expect(stageSubtasks.length).toBe(0);
  });

  it("orchestrator loop with pause_for_input", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);
    const task = createTestTask();

    const backend = createSequenceBackend([
      // Orchestrator pauses for input
      makeDecisionOutput({
        action: "pause_for_input",
        target_stage: "planning",
        reason: "waiting for stakeholder approval",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBeDefined();
    expect(task.pauseReason).toContain("waiting for stakeholder approval");

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("task_paused");

    // Task should be persisted with paused status
    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("paused");
  });
});
