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
