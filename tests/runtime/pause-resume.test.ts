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

// Import module under test -- worker (for integration tests)
import { runTask } from "../../src/runtime/worker.js";

// Import module under test -- pause-controller (does not exist yet, causes RED)
import {
  resumeTask,
  checkTimeouts,
  DEFAULT_RESUME_TIMEOUT_MS,
} from "../../src/runtime/pause-controller.js";

// Import real dependency modules used for assertions
import { readJournal } from "../../src/runtime/journal.js";
import {
  persistTask,
  loadTask,
  enqueueSubtask,
} from "../../src/runtime/task-state.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  OrchestratorConfig,
  StageDefinition,
  StageInput,
  StageOutput,
} from "../../src/recipes/types.js";
import type { StepOutput, AgentBackend } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-pause-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
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

/** Factory for a Task already in paused state with full pause context. */
function createPausedTask(overrides?: Partial<Task>): Task {
  const now = new Date();
  return createTestTask({
    status: "paused",
    pausedAt: now,
    pauseReason: "need human review",
    resumeDeadlineAt: new Date(now.getTime() + 1_800_000),
    currentStageId: "planning",
    ...overrides,
  });
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
function createOrchestratorConfig(
  overrides?: Partial<OrchestratorConfig>,
): OrchestratorConfig {
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
function createStageDefinition(
  overrides?: Partial<StageDefinition>,
): StageDefinition {
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
 */
function createMockBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(
        `Mock backend exhausted: no response for call ${callIndex}`,
      );
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
// Group 1: Pause State Persistence
// ---------------------------------------------------------------

describe("Pause State Persistence", () => {
  it("pause_for_input stores pending context and resume deadline", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask({ currentStageId: "planning" });

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
    expect(task.pauseReason).toContain("need human review");
    expect(task.pausedAt).toBeInstanceOf(Date);
    // The enhancement: resumeDeadlineAt must be set to a future date
    expect(task.resumeDeadlineAt).toBeInstanceOf(Date);
    expect(task.resumeDeadlineAt!.getTime()).toBeGreaterThan(
      task.pausedAt!.getTime(),
    );
    // currentStageId should be preserved for resume context
    expect(task.currentStageId).toBe("planning");
  });

  it("paused task state survives persist-load roundtrip", async () => {
    const task = createPausedTask();
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("paused");
    expect(loaded!.pauseReason).toBe("need human review");
    expect(loaded!.pausedAt).toBeInstanceOf(Date);
    expect(loaded!.resumeDeadlineAt).toBeInstanceOf(Date);
    expect(loaded!.resumeDeadlineAt!.getTime()).toBe(
      task.resumeDeadlineAt!.getTime(),
    );
    expect(loaded!.currentStageId).toBe("planning");
  });

  it("paused status is distinct from failed status", () => {
    const pausedTask = createPausedTask();
    const failedTask = createTestTask({
      status: "failed",
      error: "something broke",
    });

    expect(pausedTask.status).toBe("paused");
    expect(failedTask.status).toBe("failed");
    expect(pausedTask.status).not.toBe(failedTask.status);
    // Paused task has no error field
    expect(pausedTask.error).toBeUndefined();
    // Failed task has error but no pause reason
    expect(failedTask.pauseReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Group 2: Resume Operation
// ---------------------------------------------------------------

describe("Resume Operation", () => {
  it("resumeTask applies human input and enqueues resume_after_input", async () => {
    const task = createPausedTask();
    await persistTask(runsDir, task);

    const result = await resumeTask(runsDir, task, "approved with changes");

    expect(result).toBe(true);
    expect(task.capturedHumanContext).toBe("approved with changes");

    // A resume_after_input subtask should be enqueued
    const resumeSubtasks = task.subtasks!.filter(
      (s) => s.kind === "resume_after_input",
    );
    expect(resumeSubtasks.length).toBe(1);

    // Journal should contain task_resumed entry
    const journal = readJournal(runsDir, task.id);
    const resumedEntries = journal.filter((e) => e.type === "task_resumed");
    expect(resumedEntries.length).toBe(1);
  });

  it("duplicate resume is idempotent when task is not paused", async () => {
    const task = createTestTask({ status: "active" });
    await persistTask(runsDir, task);

    const result = await resumeTask(runsDir, task, "some input");

    expect(result).toBe(false);
    // No subtask enqueued
    expect(
      task.subtasks!.filter((s) => s.kind === "resume_after_input").length,
    ).toBe(0);
    // No journal entry
    const journal = readJournal(runsDir, task.id);
    const resumedEntries = journal.filter((e) => e.type === "task_resumed");
    expect(resumedEntries.length).toBe(0);
  });

  it("second resume on already-resumed task is idempotent", async () => {
    const task = createPausedTask();
    await persistTask(runsDir, task);

    // First resume succeeds
    const firstResult = await resumeTask(
      runsDir,
      task,
      "first input",
    );
    expect(firstResult).toBe(true);

    // Second resume should be a no-op (task is no longer "paused" after first resume
    // enqueues resume_after_input -- the status transitions or the guard catches it)
    const secondResult = await resumeTask(
      runsDir,
      task,
      "second input",
    );
    expect(secondResult).toBe(false);

    // Only one resume_after_input subtask should exist
    const resumeSubtasks = task.subtasks!.filter(
      (s) => s.kind === "resume_after_input",
    );
    expect(resumeSubtasks.length).toBe(1);

    // Only one task_resumed journal entry
    const journal = readJournal(runsDir, task.id);
    const resumedEntries = journal.filter((e) => e.type === "task_resumed");
    expect(resumedEntries.length).toBe(1);
  });
});

// ---------------------------------------------------------------
// Group 3: Timeout Management
// ---------------------------------------------------------------

describe("Timeout Management", () => {
  it("checkTimeouts transitions expired paused task to waiting", async () => {
    const expiredDeadline = new Date(Date.now() - 3_600_000); // 1 hour ago
    const task = createPausedTask({ resumeDeadlineAt: expiredDeadline });
    await persistTask(runsDir, task);

    await checkTimeouts(runsDir, [task]);

    expect(task.status).toBe("waiting");
    expect(task.waitingSince).toBeInstanceOf(Date);

    // Journal should contain task_waiting entry
    const journal = readJournal(runsDir, task.id);
    const waitingEntries = journal.filter((e) => e.type === "task_waiting");
    expect(waitingEntries.length).toBe(1);
  });

  it("checkTimeouts does not affect tasks within deadline", async () => {
    const futureDeadline = new Date(Date.now() + 3_600_000); // 1 hour in the future
    const task = createPausedTask({ resumeDeadlineAt: futureDeadline });
    await persistTask(runsDir, task);

    await checkTimeouts(runsDir, [task]);

    expect(task.status).toBe("paused");

    // No task_waiting journal entry
    const journal = readJournal(runsDir, task.id);
    const waitingEntries = journal.filter((e) => e.type === "task_waiting");
    expect(waitingEntries.length).toBe(0);
  });

  it("checkTimeouts handles multiple tasks with mixed deadlines", async () => {
    const expiredTask = createPausedTask({
      id: "task-expired",
      resumeDeadlineAt: new Date(Date.now() - 3_600_000),
    });
    const activeTask = createPausedTask({
      id: "task-active",
      resumeDeadlineAt: new Date(Date.now() + 3_600_000),
    });
    const alreadyWaitingTask = createTestTask({
      id: "task-waiting",
      status: "waiting",
      waitingSince: new Date(Date.now() - 7_200_000),
    });

    await persistTask(runsDir, expiredTask);
    await persistTask(runsDir, activeTask);
    await persistTask(runsDir, alreadyWaitingTask);

    await checkTimeouts(runsDir, [expiredTask, activeTask, alreadyWaitingTask]);

    // Only expired task transitions to waiting
    expect(expiredTask.status).toBe("waiting");
    expect(expiredTask.waitingSince).toBeInstanceOf(Date);

    // Active task stays paused
    expect(activeTask.status).toBe("paused");

    // Already waiting task remains unchanged
    expect(alreadyWaitingTask.status).toBe("waiting");

    // Only one task_waiting journal entry (for the expired one)
    const expiredJournal = readJournal(runsDir, expiredTask.id);
    expect(
      expiredJournal.filter((e) => e.type === "task_waiting").length,
    ).toBe(1);

    const activeJournal = readJournal(runsDir, activeTask.id);
    expect(
      activeJournal.filter((e) => e.type === "task_waiting").length,
    ).toBe(0);
  });

  it("waiting tasks do not block unrelated tasks", () => {
    const waitingTask = createTestTask({
      status: "waiting",
      waitingSince: new Date(),
    });

    // Verify the status semantics: waiting is not active or paused
    expect(waitingTask.status).toBe("waiting");
    expect(waitingTask.status).not.toBe("active");
    expect(waitingTask.status).not.toBe("paused");
    // Waiting task would not be selected by queue logic filtering for active/queued tasks
    expect(waitingTask.status).not.toBe("queued");
  });
});

// ---------------------------------------------------------------
// Group 4: resume_after_input Handler (Integration)
// ---------------------------------------------------------------

describe("resume_after_input Handler", () => {
  it("resume_after_input applies captured input and enqueues orchestrator_eval", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);

    // Create a task that was paused and then resumed (has capturedHumanContext
    // and a resume_after_input subtask queued)
    const task = createTestTask({
      status: "active",
      capturedHumanContext: "user approved the plan",
      currentStageId: "planning",
    });

    // Pre-enqueue a resume_after_input subtask
    await enqueueSubtask(runsDir, task, {
      kind: "resume_after_input",
      stageId: "planning",
    });

    // After resume_after_input, the orchestrator gets called and finishes the run
    const backend = createMockBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done after resume" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir);

    // Task should reach completed state
    expect(task.status).toBe("completed");

    // Backend was called (orchestrator invoked after resume_after_input)
    expect(backend.run).toHaveBeenCalled();

    // Journal should contain subtask_completed for resume_after_input
    const journal = readJournal(runsDir, task.id);
    const completedEntries = journal.filter(
      (e) =>
        e.type === "subtask_completed" && e.kind === "resume_after_input",
    );
    expect(completedEntries.length).toBe(1);
  });

  it("full pause-resume cycle: pause mid-run then resume continues correctly", async () => {
    const recipe = createTestRecipe();
    await writeOrchestratorRole(recipe);
    const task = createTestTask();

    // First run: orchestrator returns pause_for_input
    const pauseBackend = createMockBackend([
      makeDecisionOutput({
        action: "pause_for_input",
        target_stage: "planning",
        reason: "need human review",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(pauseBackend);

    await runTask(task, recipe, runsDir);

    // After first run, task is paused
    expect(task.status).toBe("paused");
    expect(task.pauseReason).toContain("need human review");
    expect(task.currentStageId).toBe("planning");

    // External resume: apply human input via pause-controller
    const resumed = await resumeTask(
      runsDir,
      task,
      "approved, proceed with implementation",
    );
    expect(resumed).toBe(true);
    expect(task.capturedHumanContext).toBe(
      "approved, proceed with implementation",
    );

    // resume_after_input subtask should be queued
    const resumeSubtasks = task.subtasks!.filter(
      (s) => s.kind === "resume_after_input",
    );
    expect(resumeSubtasks.length).toBe(1);

    // Second run: worker picks up resume_after_input, then orchestrator finishes
    vi.clearAllMocks();
    const finishBackend = createMockBackend([
      makeDecisionOutput({
        action: "finish_run",
        reason: "completed after human input",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(finishBackend);

    await runTask(task, recipe, runsDir);

    // Task should now be completed
    expect(task.status).toBe("completed");

    // Verify journal has the full lifecycle
    const journal = readJournal(runsDir, task.id);
    const entryTypes = journal.map((e) => e.type);
    expect(entryTypes).toContain("task_paused");
    expect(entryTypes).toContain("task_resumed");
    expect(entryTypes).toContain("task_completed");

    // Verify ordering: task_paused before task_resumed before task_completed
    const pausedIdx = entryTypes.indexOf("task_paused");
    const resumedIdx = entryTypes.indexOf("task_resumed");
    const completedIdx = entryTypes.indexOf("task_completed");
    expect(pausedIdx).toBeLessThan(resumedIdx);
    expect(resumedIdx).toBeLessThan(completedIdx);
  });
});
