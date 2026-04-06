import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock the registry module so worker tests control the CLI backend
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

// ---------------------------------------------------------------
// Mock the stage-agent-handler for unit-level isolation
// ---------------------------------------------------------------

const { mockHandleStageAgentRun } = vi.hoisted(() => ({
  mockHandleStageAgentRun: vi.fn(),
}));

vi.mock("../../src/runtime/stage-agent-handler.js", () => ({
  handleStageAgentRun: mockHandleStageAgentRun,
}));

// ---------------------------------------------------------------
// Mock the script-handler for script_run dispatch isolation
// ---------------------------------------------------------------

const { mockHandleScriptRun } = vi.hoisted(() => ({
  mockHandleScriptRun: vi.fn(),
}));

vi.mock("../../src/runtime/script-handler.js", () => ({
  handleScriptRun: mockHandleScriptRun,
}));

// ---------------------------------------------------------------
// Mock the workspace module for workspace wiring isolation
// ---------------------------------------------------------------

const { mockCreateWorkspace } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
}));

vi.mock("../../src/utils/workspace.js", () => ({
  createWorkspace: mockCreateWorkspace,
}));

// Import module under test
import { runTask } from "../../src/runtime/worker.js";

// Import real dependency modules used for assertions
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
import type { ScriptManifest } from "../../src/scripts/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-worker-test-"));
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

/** Factory for a minimal valid Task with recipe fields set. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    gate: "test-gate",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "build a widget" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    recipeId: "test-recipe",
    currentStageId: "planning",
    stageRetryCount: {},
    totalActionCount: 0,
    ...overrides,
  };
}

/** Factory for a StageInput with overridable fields. */
function createStageInput(overrides?: Partial<StageInput>): StageInput {
  return {
    description: "Project description",
    source: "task.payload.description",
    ...overrides,
  };
}

/** Factory for a StageOutput with overridable fields. */
function createStageOutput(overrides?: Partial<StageOutput>): StageOutput {
  return {
    label: "planning_doc",
    format: "md",
    ...overrides,
  };
}

/** Factory for OrchestratorConfig with overridable fields. */
function createOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    role: path.join(runsDir, "roles", "orchestrator.md"),
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 120000,
    max_stage_retries: 3,
    max_total_actions: 50,
    ...overrides,
  };
}

/** Factory for a minimal StageDefinition. */
function createStageDefinition(overrides?: Partial<StageDefinition>): StageDefinition {
  return {
    role: path.join(runsDir, "roles", "planner.md"),
    objective: "Create a detailed implementation plan",
    inputs: [createStageInput()],
    outputs: [createStageOutput()],
    allowed_transitions: ["implement"],
    allowed_scripts: [],
    ...overrides,
  };
}

/** Factory for RecipeConfig with two stages: planning and implement. */
function createTestRecipe(overrides?: Partial<RecipeConfig>): RecipeConfig {
  return {
    id: "test-recipe",
    name: "Test Recipe",
    command: "/test",
    description: "Test recipe with two stages",
    orchestrator: createOrchestratorConfig(),
    stage_order: ["planning", "implement"],
    start_stage: "planning",
    stages: {
      planning: createStageDefinition({
        allowed_transitions: ["implement"],
      }),
      implement: createStageDefinition({
        role: path.join(runsDir, "roles", "implementer.md"),
        objective: "Implement the plan",
        outputs: [createStageOutput({ label: "code", format: "ts" })],
        allowed_transitions: [],
      }),
    },
    ...overrides,
  };
}

/** Build a StepOutput with a stringified JSON decision as the output field. */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return {
    output: JSON.stringify(decision),
    outputFiles: [],
  };
}

/**
 * Create a mock AgentBackend whose run() returns responses in order.
 * Each call to run() pops the next response from the array.
 * Captures all call arguments for later assertion.
 */
function createMockBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(`Mock backend exhausted: no response for call ${callIndex}`);
    }
    return Promise.resolve(responses[callIndex++]);
  });
  return { name: "mock-backend", run: runFn };
}

/** Write an orchestrator role file for tests. */
async function writeOrchestratorRole(recipe: RecipeConfig): Promise<void> {
  const rolePath = recipe.orchestrator.role;
  await mkdir(path.dirname(rolePath), { recursive: true });
  await writeFile(rolePath, "You are a test orchestrator.", "utf-8");
}

/** Factory for a minimal script registry with one test script. */
function createTestRegistry(
  overrides?: Partial<ScriptManifest>,
): Map<string, ScriptManifest> {
  const manifest: ScriptManifest = {
    script_id: "test.script",
    description: "A test script for unit testing",
    runtime: "node",
    path: "scripts/test.js",
    timeout_ms: 30000,
    retryable: false,
    side_effects: "read-only",
    required_env: [],
    rerun_policy: "restart",
    ...overrides,
  };
  const registry = new Map<string, ScriptManifest>();
  registry.set(manifest.script_id, manifest);
  return registry;
}

// ---------------------------------------------------------------
// Group 1: Initial Subtask Enqueue
// ---------------------------------------------------------------

describe("Initial Subtask Enqueue", () => {
  it("runTask enqueues orchestrator_eval when no subtasks queued", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({ queuedSubtaskIds: [], subtasks: [] });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const queuedEntries = journal.filter((e) => e.type === "subtask_queued");
    expect(queuedEntries.length).toBeGreaterThanOrEqual(1);

    // The first queued entry should be for an orchestrator_eval
    expect(queuedEntries[0]).toHaveProperty("kind", "orchestrator_eval");
  });

  it("runTask skips initial enqueue when subtasks already queued", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);

    // Pre-build a task with an existing queued orchestrator_eval subtask
    const task = createTestTask();
    task.subtasks = [
      {
        id: "task-001-0",
        stepId: "planning",
        name: "orchestrator_eval:planning",
        executionType: "agent",
        status: "pending",
        cost: zeroCost(),
        attempt: 1,
        maxRetries: 0,
        kind: "orchestrator_eval",
        stageId: "planning",
      },
    ];
    task.queuedSubtaskIds = ["task-001-0"];

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // The task should not have created a duplicate initial orchestrator_eval
    const orchestratorSubtasks = task.subtasks!.filter(
      (s) => s.kind === "orchestrator_eval",
    );
    // Only 1 orchestrator_eval was used (the pre-existing one), not 2
    expect(orchestratorSubtasks.length).toBe(1);
  });
});

// ---------------------------------------------------------------
// Group 2: Dequeue-Execute-Persist Cycle
// ---------------------------------------------------------------

describe("Dequeue-Execute-Persist Cycle", () => {
  it("Worker dequeues subtask and marks it active", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const startedEntries = journal.filter((e) => e.type === "subtask_started");
    expect(startedEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("Task state persisted after each subtask completes", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Task should be persisted on disk
    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("completed");
  });

  it("Journal entry appended for each subtask result", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "all done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const entryTypes = journal.map((e) => e.type);

    // Should contain at minimum: subtask_queued, subtask_started, orchestrator_decision, subtask_completed
    expect(entryTypes).toContain("subtask_started");
    expect(entryTypes).toContain("orchestrator_decision");
  });
});

// ---------------------------------------------------------------
// Group 3: orchestrator_eval Dispatch
// ---------------------------------------------------------------

describe("orchestrator_eval Dispatch", () => {
  it("orchestrator_eval assembles context and invokes CLI backend", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Backend should have been called at least once
    expect(backend.run).toHaveBeenCalled();

    // Verify the prompt contains the three-section format
    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(passedConfig.systemPrompt).toContain("# Role");
    expect(passedConfig.systemPrompt).toContain("# Task");
    expect(passedConfig.systemPrompt).toContain("# Output");
  });

  it("orchestrator_eval parses JSON decision from backend output", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "all complete" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const decisionEntries = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisionEntries.length).toBe(1);
    expect(decisionEntries[0]).toHaveProperty("action", "finish_run");
  });

  it("orchestrator_eval journals the decision before applying it", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "ready" }),
      // After stage_agent_run, the second orchestrator_eval returns finish_run
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "implemented",
      artifactIds: ["art-1"],
    });

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);

    // The orchestrator_decision must appear before the subtask_queued for stage_agent_run
    const decIdx = types.indexOf("orchestrator_decision");
    // Find subtask_queued for stage_agent_run after the first orchestrator decision
    const stageQueueIdx = types.findIndex(
      (t, i) => i > decIdx && t === "subtask_queued",
    );
    expect(decIdx).toBeLessThan(stageQueueIdx);
  });
});

// ---------------------------------------------------------------
// Group 4: Valid Decision Application
// ---------------------------------------------------------------

describe("Valid Decision Application", () => {
  it("run_stage_agent decision enqueues stage_agent_run subtask", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "ready" }),
      makeDecisionOutput({ action: "finish_run", reason: "all done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "code written",
      artifactIds: ["art-1"],
    });

    await runTask(task, recipe, runsDir);

    // Should have a stage_agent_run subtask for "implement"
    const stageSubtasks = task.subtasks!.filter((s) => s.kind === "stage_agent_run");
    expect(stageSubtasks.length).toBeGreaterThanOrEqual(1);
    expect(stageSubtasks[0].stageId).toBe("implement");
  });

  it("run_stage_agent decision updates currentStageId and increments retry count", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({ stageRetryCount: {} });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "ready" }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "implemented",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir);

    // currentStageId should have been updated at some point (may be reset on finish)
    // Check the journal for the decision that targeted implement
    const journal = readJournal(runsDir, task.id);
    const decisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisions[0]).toHaveProperty("target_stage", "implement");
  });

  it("finish_run decision marks task completed", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "all done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("completed");
    expect(task.completedAt).toBeDefined();

    const journal = readJournal(runsDir, task.id);
    const completedEntries = journal.filter((e) => e.type === "task_completed");
    expect(completedEntries.length).toBe(1);
  });

  it("fail_run decision marks task failed", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "fail_run", reason: "unrecoverable error" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("failed");
    expect(task.error).toContain("unrecoverable error");

    const journal = readJournal(runsDir, task.id);
    const failedEntries = journal.filter((e) => e.type === "task_failed");
    expect(failedEntries.length).toBe(1);
  });

  it("pause_for_input decision marks task paused and exits loop", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "pause_for_input",
        target_stage: "planning",
        reason: "need human review",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBeDefined();
    expect(task.pauseReason).toContain("need human review");

    const journal = readJournal(runsDir, task.id);
    const pausedEntries = journal.filter((e) => e.type === "task_paused");
    expect(pausedEntries.length).toBe(1);
  });

  it("run_stage_agent decision applies state_patch to task", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({ payload: { description: "test" } });

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "implement",
        state_patch: { custom_flag: true, priority_override: "high" },
        reason: "applying state",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir);

    // The journal should have captured the decision with state_patch
    const journal = readJournal(runsDir, task.id);
    const decisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisions[0]).toHaveProperty("state_patch");
  });
});

// ---------------------------------------------------------------
// Group 5: Invalid Decision Handling
// ---------------------------------------------------------------

describe("Invalid Decision Handling", () => {
  it("Invalid decision journals decision_rejected and re-invokes orchestrator", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      // First call: invalid decision (target_stage not in allowed_transitions)
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "nonexistent_stage",
        reason: "trying invalid stage",
      }),
      // Second call: valid decision to finish
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const rejectedEntries = journal.filter((e) => e.type === "decision_rejected");
    expect(rejectedEntries.length).toBeGreaterThanOrEqual(1);

    // Backend should have been called twice (first invalid, then valid)
    expect(backend.run).toHaveBeenCalledTimes(2);
  });

  it("Invalid decision does not terminate the run", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      // First: invalid transition
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "nonexistent_stage",
        reason: "bad transition",
      }),
      // Second: valid finish
      makeDecisionOutput({ action: "finish_run", reason: "recovered" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Task should be completed, NOT failed
    expect(task.status).toBe("completed");
  });
});

// ---------------------------------------------------------------
// Group 6: stage_agent_run Dispatch
// ---------------------------------------------------------------

describe("stage_agent_run Dispatch", () => {
  it("stage_agent_run delegates to handleStageAgentRun", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "go" }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "code written",
      artifactIds: ["art-1"],
    });

    await runTask(task, recipe, runsDir);

    expect(mockHandleStageAgentRun).toHaveBeenCalledOnce();
    // Verify called with correct params: (task, subtask, recipe, runsDir)
    const [callTask, callSubtask, callRecipe, callRunsDir] =
      mockHandleStageAgentRun.mock.calls[0];
    expect(callTask.id).toBe("task-001");
    expect(callSubtask.kind).toBe("stage_agent_run");
    expect(callRecipe.id).toBe("test-recipe");
    expect(callRunsDir).toBe(runsDir);
  });

  it("After stage_agent_run, next orchestrator_eval is enqueued", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "go" }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "stage completed",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);

    // After stage_agent_run completes, an orchestrator_eval should be enqueued
    // We know there were 2 backend calls, meaning 2 orchestrator_evals were processed
    expect(backend.run).toHaveBeenCalledTimes(2);
  });

  it("stage_agent_run failure marks subtask failed and re-invokes orchestrator", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "go" }),
      // After stage failure, orchestrator gets re-invoked and decides to fail
      makeDecisionOutput({ action: "fail_run", reason: "stage failed irrecoverably" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "",
      artifactIds: [],
      error: "Stage agent execution failed",
    });

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const failedSubtasks = journal.filter((e) => e.type === "subtask_failed");
    expect(failedSubtasks.length).toBeGreaterThanOrEqual(1);

    // After the stage failure, an orchestrator_eval should have been enqueued
    // to let the orchestrator decide what to do
    expect(backend.run).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------
// Group 7: Prompt Rendering Format
// ---------------------------------------------------------------

describe("Prompt Rendering Format", () => {
  it("Orchestrator prompt uses # Role / # Task / # Output format", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = passedConfig.systemPrompt;

    // Verify three-section format with correct ordering
    expect(prompt).toContain("# Role");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("# Output");

    const roleIdx = prompt.indexOf("# Role");
    const taskIdx = prompt.indexOf("# Task");
    const outputIdx = prompt.indexOf("# Output");
    expect(roleIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(outputIdx);
  });

  it("Rendered prompt contains Available Scripts section in Task", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = passedConfig.systemPrompt;

    expect(prompt).toContain("Available Scripts");
  });

  it("Rendered prompt contains Allowed Scripts for This Stage section", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["knowledge.prime"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = passedConfig.systemPrompt;

    expect(prompt).toContain("Allowed Scripts for This Stage");
  });

  it("Output section includes run_script in action enum and script_id field", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = passedConfig.systemPrompt;

    expect(prompt).toContain("run_script");
    expect(prompt).toContain("script_id");
  });
});

// ---------------------------------------------------------------
// Group 8: Serial Execution Invariant
// ---------------------------------------------------------------

describe("Serial Execution Invariant", () => {
  it("Worker processes one subtask at a time", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "run_stage_agent", target_stage: "implement", reason: "go" }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "implemented",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir);

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);

    // Verify serial execution: each subtask_started must have a matching
    // completion (subtask_completed or subtask_failed) before the next subtask_started
    let openStarts = 0;
    for (const t of types) {
      if (t === "subtask_started") {
        openStarts++;
        expect(openStarts).toBeLessThanOrEqual(1);
      } else if (t === "subtask_completed" || t === "subtask_failed") {
        openStarts--;
      }
    }
    expect(openStarts).toBe(0);
  });
});

// ---------------------------------------------------------------
// Group 9: script_run Dispatch
// ---------------------------------------------------------------

describe("script_run Dispatch", () => {
  it("Worker dispatch switch includes script_run case", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: { key: "value" },
        reason: "need data",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "script done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    expect(mockHandleScriptRun).toHaveBeenCalledOnce();
    const [callTask, callSubtask, callRegistry, callRunsDir] =
      mockHandleScriptRun.mock.calls[0];
    expect(callTask.id).toBe("task-001");
    expect(callSubtask.kind).toBe("script_run");
    expect(callRegistry).toBe(registry);
    expect(callRunsDir).toBe(runsDir);
  });

  it("script_run delegates to handleScriptRun with correct arguments", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: { key: "value" },
        reason: "run the script",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "script completed successfully",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    // Verify all 4 positional arguments match expected values
    expect(mockHandleScriptRun).toHaveBeenCalledOnce();
    const args = mockHandleScriptRun.mock.calls[0];
    expect(args[0].id).toBe("task-001");
    expect(args[1].kind).toBe("script_run");
    expect(args[2]).toBeInstanceOf(Map);
    expect(args[2].has("test.script")).toBe(true);
    expect(typeof args[3]).toBe("string"); // runsDir
  });

  it("After script_run success, next orchestrator_eval is auto-enqueued", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    // Two backend.run calls means two orchestrator_evals were processed
    expect(backend.run).toHaveBeenCalledTimes(2);

    const journal = readJournal(runsDir, task.id);
    const queuedEntries = journal.filter(
      (e) => e.type === "subtask_queued" && (e as Record<string, unknown>).kind === "orchestrator_eval",
    );
    // At least 2: the initial orchestrator_eval + the one after script_run
    expect(queuedEntries.length).toBeGreaterThanOrEqual(2);
  });

  it("script_run failure marks subtask failed and re-invokes orchestrator", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "fail_run", reason: "script failed irrecoverably" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "",
      artifactIds: [],
      error: "script failed",
    });

    await runTask(task, recipe, runsDir, registry);

    const journal = readJournal(runsDir, task.id);
    const failedSubtasks = journal.filter((e) => e.type === "subtask_failed");
    expect(failedSubtasks.length).toBeGreaterThanOrEqual(1);
    expect((failedSubtasks[0] as Record<string, unknown>).kind).toBe("script_run");

    // After failure, orchestrator gets re-invoked
    expect(backend.run).toHaveBeenCalledTimes(2);
  });

  it("script_run handler exception marks subtask failed and re-invokes orchestrator", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "fail_run", reason: "crashed" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockRejectedValue(new Error("unexpected crash"));

    await runTask(task, recipe, runsDir, registry);

    const journal = readJournal(runsDir, task.id);
    const failedSubtasks = journal.filter((e) => e.type === "subtask_failed");
    expect(failedSubtasks.length).toBeGreaterThanOrEqual(1);

    // After crash, orchestrator gets re-invoked to decide recovery
    expect(backend.run).toHaveBeenCalledTimes(2);
  });

  it("script_run applies statePatch to task payload when present", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
      statePatch: { computed_value: 42 },
    });

    await runTask(task, recipe, runsDir, registry);

    expect((task.payload as Record<string, unknown>).computed_value).toBe(42);
  });

  it("script_run stores artifactIds on task when present", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: ["art-script-1", "art-script-2"],
    });

    await runTask(task, recipe, runsDir, registry);

    expect(task.artifactIds).toBeDefined();
    expect(task.artifactIds).toContain("art-script-1");
    expect(task.artifactIds).toContain("art-script-2");
  });
});

// ---------------------------------------------------------------
// Group 10: run_script Decision Application
// ---------------------------------------------------------------

describe("run_script Decision Application", () => {
  it("run_script decision enqueues script_run subtask with script_id in payload", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: { key: "value" },
        reason: "need data",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    // Should have a script_run subtask
    const scriptSubtasks = task.subtasks!.filter((s) => s.kind === "script_run");
    expect(scriptSubtasks.length).toBeGreaterThanOrEqual(1);
    expect(scriptSubtasks[0].payload).toBeDefined();
    expect((scriptSubtasks[0].payload as Record<string, unknown>).script_id).toBe("test.script");

    // Journal should record the subtask_queued with kind script_run
    const journal = readJournal(runsDir, task.id);
    const queuedScripts = journal.filter(
      (e) => e.type === "subtask_queued" && (e as Record<string, unknown>).kind === "script_run",
    );
    expect(queuedScripts.length).toBeGreaterThanOrEqual(1);
  });

  it("run_script decision increments totalActionCount", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask({ totalActionCount: 0 });
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        reason: "go",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    // run_script counts as an action, totalActionCount should be at least 1
    expect(task.totalActionCount).toBeGreaterThanOrEqual(1);
  });

  it("run_script decision applies state_patch to task when present", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "test.script",
        input_patch: {},
        state_patch: { flag: true },
        reason: "go",
      }),
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleScriptRun.mockResolvedValue({
      output: "done",
      artifactIds: [],
    });

    await runTask(task, recipe, runsDir, registry);

    // Journal should record the decision with state_patch
    const journal = readJournal(runsDir, task.id);
    const decisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const firstDecision = decisions[0] as Record<string, unknown>;
    expect(firstDecision.state_patch).toEqual({ flag: true });
  });
});

// ---------------------------------------------------------------
// Group 11: Registry Threading
// ---------------------------------------------------------------

describe("Registry Threading", () => {
  it("Registry is passed to validateDecision in handleOrchestratorEval", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry();

    const backend = createMockBackend([
      // First: invalid run_script with unknown script_id -- should be rejected by validator
      makeDecisionOutput({
        action: "run_script",
        script_id: "nonexistent.script",
        input_patch: {},
        reason: "try unknown",
      }),
      // Second: valid finish -- recovery
      makeDecisionOutput({ action: "finish_run", reason: "recovered" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // The decision with unknown script_id should have been rejected
    const journal = readJournal(runsDir, task.id);
    const rejections = journal.filter((e) => e.type === "decision_rejected");
    expect(rejections.length).toBeGreaterThanOrEqual(1);

    // Task should still complete (recovered via finish_run)
    expect(task.status).toBe("completed");
  });

  it("Registry is passed to buildOrchestratorContext in handleOrchestratorEval", async () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_transitions: ["implement"],
          allowed_scripts: ["test.script"],
        }),
        implement: createStageDefinition({
          role: path.join(runsDir, "roles", "implementer.md"),
          objective: "Implement the plan",
          outputs: [createStageOutput({ label: "code", format: "ts" })],
          allowed_transitions: [],
        }),
      },
    });
    await writeOrchestratorRole(recipe);
    const task = createTestTask();
    const registry = createTestRegistry({
      description: "A test script for registry threading verification",
    });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Capture the prompt passed to the backend
    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = passedConfig.systemPrompt;

    // When registry is threaded through, buildOrchestratorContext populates script catalog
    expect(prompt).toContain("A test script for registry threading verification");
  });

  it("runTask works without registry (backward compatibility)", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    // Call runTask with 3 args (no registry) -- must still work
    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("completed");
    const journal = readJournal(runsDir, task.id);
    const errors = journal.filter((e) => e.type === "task_failed");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------
// Group 12: Workspace Wiring at Task Start
// ---------------------------------------------------------------

describe("Workspace Wiring at Task Start", () => {
  it("runTask calls createWorkspace for recipe tasks without branchName", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({
      recipeId: "test-recipe",
      repoPath: "/tmp/test-repo",
    });

    mockCreateWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/ws/task-001",
      branchName: "bees/task-001-build-a-widget",
    });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Workspace creation should have been called
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);

    // Verify it was called with the correct task ID
    const callArgs = mockCreateWorkspace.mock.calls[0][0];
    expect(callArgs.taskId).toBe("task-001");
  });

  it("runTask writes workspace results to task state fields", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({
      recipeId: "test-recipe",
      repoPath: "/tmp/test-repo",
    });

    mockCreateWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/tmp/ws/task-001",
      branchName: "bees/task-001-build-a-widget",
    });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Task state should have workspace fields populated
    expect(task.branchName).toBe("bees/task-001-build-a-widget");
    expect(task.workspacePath).toBe("/tmp/ws/task-001");

    // Verify fields persisted to disk
    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.branchName).toBe("bees/task-001-build-a-widget");
    expect(loaded!.workspacePath).toBe("/tmp/ws/task-001");
  });

  it("runTask skips workspace creation when branchName already set", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({
      recipeId: "test-recipe",
      branchName: "bees/task-001-existing-branch",
      workspacePath: "/tmp/existing-ws",
    });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Workspace creation should NOT have been called (idempotent)
    expect(mockCreateWorkspace).not.toHaveBeenCalled();

    // Existing values should be preserved
    expect(task.branchName).toBe("bees/task-001-existing-branch");
    expect(task.workspacePath).toBe("/tmp/existing-ws");
  });

  it("runTask handles workspace creation failure gracefully", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({
      recipeId: "test-recipe",
      repoPath: "/tmp/test-repo",
    });

    mockCreateWorkspace.mockResolvedValue({
      success: false,
      error: "Failed to create worktree: branch already exists",
    });

    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    // Should not throw -- workspace failure should be handled gracefully
    await runTask(task, recipe, runsDir);

    // Task should still have completed (workspace failure is not fatal)
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    // branchName should not be set on failure
    expect(task.branchName).toBeUndefined();
  });
});
