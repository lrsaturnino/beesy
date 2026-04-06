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

// Import runtime modules under test
import { runTask } from "../../src/runtime/worker.js";
import { readJournal } from "../../src/runtime/journal.js";
import {
  persistTask,
  loadTask,
  enqueueSubtask,
  markSubtaskActive,
  recoverTasks,
} from "../../src/runtime/task-state.js";
import {
  performRecovery,
  rebuildQueueForActiveTask,
} from "../../src/runtime/task-state.js";
import { resumeTask, checkTimeouts } from "../../src/runtime/pause-controller.js";
import type { Task, Subtask } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  OrchestratorConfig,
} from "../../src/recipes/types.js";
import type { StepOutput, AgentBackend } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-recovery-int-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator. */
function zeroCost() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** Factory for a minimal valid Task with recipe fields. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-int-001",
    gate: "test-gate",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "integration test task" },
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

/** Factory for a two-stage integration recipe. */
function createIntegrationRecipe(overrides?: Partial<RecipeConfig>): RecipeConfig {
  const orchestratorRolePath = path.join(runsDir, "roles", "orchestrator.md");
  const plannerRolePath = path.join(runsDir, "roles", "planner.md");
  const implementerRolePath = path.join(runsDir, "roles", "implementer.md");

  return {
    id: "test-recipe",
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

/** Build a StepOutput simulating a stage agent producing text. */
function makeStageOutput(text: string): StepOutput {
  return { output: text, outputFiles: [] };
}

/** Create a mock backend that returns responses in sequence. */
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

/** Write all role files needed for an integration recipe. */
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

// ---------------------------------------------------------------
// Integration: Write state, simulate restart, verify recovery
// ---------------------------------------------------------------

describe("Integration: Recovery after simulated restart", () => {
  it("writes task state, simulates restart, verifies correct next subtask", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);

    // Create a task that was mid-execution: 2 completed subtasks, 1 active (interrupted)
    const task = createTestTask({
      id: "task-recovery-001",
      status: "active",
      currentStageId: "planning",
      activeSubtaskId: "task-recovery-001-2",
      subtasks: [
        {
          id: "task-recovery-001-0",
          stepId: "planning",
          name: "orchestrator_eval:planning",
          executionType: "agent",
          status: "completed",
          cost: zeroCost(),
          attempt: 1,
          maxRetries: 0,
          kind: "orchestrator_eval",
          stageId: "planning",
          startedAt: new Date("2026-04-06T01:00:00.000Z"),
          completedAt: new Date("2026-04-06T01:01:00.000Z"),
        },
        {
          id: "task-recovery-001-1",
          stepId: "planning",
          name: "stage_agent_run:planning",
          executionType: "agent",
          status: "completed",
          cost: zeroCost(),
          attempt: 1,
          maxRetries: 0,
          kind: "stage_agent_run",
          stageId: "planning",
          startedAt: new Date("2026-04-06T01:01:00.000Z"),
          completedAt: new Date("2026-04-06T01:05:00.000Z"),
          output: "Plan created: architecture document",
        },
        {
          id: "task-recovery-001-2",
          stepId: "planning",
          name: "orchestrator_eval:planning",
          executionType: "agent",
          status: "active",
          cost: zeroCost(),
          attempt: 1,
          maxRetries: 0,
          kind: "orchestrator_eval",
          stageId: "planning",
          startedAt: new Date("2026-04-06T01:05:00.000Z"),
          // No completedAt -- simulating crash during execution
        },
      ],
      queuedSubtaskIds: [],
    });

    // Persist to disk (simulating pre-crash state)
    await persistTask(runsDir, task);

    // Simulate restart: reload from disk
    const loadedTask = await loadTask(runsDir, "task-recovery-001");
    expect(loadedTask).not.toBeNull();
    expect(loadedTask!.status).toBe("active");

    // Run recovery on the loaded task
    await rebuildQueueForActiveTask(runsDir, loadedTask!);

    // Verify: interrupted subtask handled, queue rebuilt
    expect(loadedTask!.queuedSubtaskIds!.length).toBeGreaterThanOrEqual(1);
    expect(loadedTask!.activeSubtaskId).toBeUndefined();

    // The worker should be able to continue from the recovery point
    const backend = createSequenceBackend([
      // After recovery, orchestrator decides to finish
      makeDecisionOutput({ action: "finish_run", reason: "recovery complete" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(loadedTask!, recipe, runsDir);

    expect(loadedTask!.status).toBe("completed");

    // Journal should show recovery happened and task completed
    const journal = readJournal(runsDir, loadedTask!.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("task_completed");

    // Prior subtask records should not have been mutated
    const priorCompleted = loadedTask!.subtasks!.filter(
      (s) =>
        (s.id === "task-recovery-001-0" || s.id === "task-recovery-001-1") &&
        s.status === "completed",
    );
    expect(priorCompleted).toHaveLength(2);
  });

  it("simulate crash mid-run, recover, verify correct continuation", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);

    const task = createTestTask({ id: "task-crash-001" });

    // First run: orchestrator starts planning, then we simulate a crash
    // by having the backend throw on the second call
    let callCount = 0;
    const crashBackend: AgentBackend = {
      name: "crash-backend",
      run: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First orchestrator_eval: run planning stage
          return Promise.resolve(
            makeDecisionOutput({
              action: "run_stage_agent",
              target_stage: "planning",
              reason: "start planning",
            }),
          );
        }
        if (callCount === 2) {
          // Planning stage_agent_run: completes
          return Promise.resolve(makeStageOutput("Plan: architecture document"));
        }
        // Third call: simulate crash
        throw new Error("Process crashed");
      }),
    };
    mockResolveAgentBackend.mockReturnValue(crashBackend);

    // First run -- will throw on 3rd backend call (2nd orchestrator_eval)
    try {
      await runTask(task, recipe, runsDir);
    } catch {
      // Expected: simulated crash
    }

    // Persist task state as it was at time of crash
    await persistTask(runsDir, task);

    // Simulate restart: reload from disk
    const loadedTask = await loadTask(runsDir, task.id);
    expect(loadedTask).not.toBeNull();

    // Run recovery
    await rebuildQueueForActiveTask(runsDir, loadedTask!);

    // Second run: recover and complete
    vi.clearAllMocks();
    const recoveryBackend = createSequenceBackend([
      // Post-recovery orchestrator decides to run implement
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "implement",
        reason: "plan done, implement now",
      }),
      // Implement stage agent
      makeStageOutput("Code written: widget.ts"),
      // Final orchestrator: finish
      makeDecisionOutput({ action: "finish_run", reason: "all done" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(recoveryBackend);

    await runTask(loadedTask!, recipe, runsDir);

    expect(loadedTask!.status).toBe("completed");

    // Journal should have entries from both runs
    const journal = readJournal(runsDir, loadedTask!.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("task_completed");
  });
});

// ---------------------------------------------------------------
// Integration: Recovery of paused task preserves resume capability
// ---------------------------------------------------------------

describe("Integration: Paused task recovery preserves resume", () => {
  it("recovered paused task can still be resumed", async () => {
    const recipe = createIntegrationRecipe();
    await writeAllRoleFiles(recipe);

    // Create a paused task with full pause context
    const task = createTestTask({
      id: "task-paused-recover",
      status: "paused",
      pausedAt: new Date(),
      pauseReason: "need stakeholder approval",
      resumeDeadlineAt: new Date(Date.now() + 1_800_000),
      currentStageId: "planning",
    });
    await persistTask(runsDir, task);

    // Simulate restart: reload from disk
    const loadedTask = await loadTask(runsDir, task.id);
    expect(loadedTask).not.toBeNull();
    expect(loadedTask!.status).toBe("paused");
    expect(loadedTask!.pausedAt).toBeInstanceOf(Date);
    expect(loadedTask!.pauseReason).toBe("need stakeholder approval");
    expect(loadedTask!.resumeDeadlineAt).toBeInstanceOf(Date);
    expect(loadedTask!.currentStageId).toBe("planning");

    // Resume the recovered task
    const resumed = await resumeTask(
      runsDir,
      loadedTask!,
      "approved with minor changes",
    );

    expect(resumed).toBe(true);
    expect(loadedTask!.status).toBe("active");
    expect(loadedTask!.capturedHumanContext).toBe("approved with minor changes");

    // resume_after_input subtask should be enqueued
    const resumeSubtasks = loadedTask!.subtasks!.filter(
      (s) => s.kind === "resume_after_input",
    );
    expect(resumeSubtasks).toHaveLength(1);

    // Worker can pick up and continue
    const backend = createSequenceBackend([
      makeDecisionOutput({ action: "finish_run", reason: "done after resume" }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(loadedTask!, recipe, runsDir);

    expect(loadedTask!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------
// Integration: Recovery preserves journal continuity
// ---------------------------------------------------------------

describe("Integration: Journal continuity across recovery", () => {
  it("pre-crash journal entries are preserved and recovery entries appended after", async () => {
    const taskId = "task-journal-continuity";
    const task = createTestTask({
      id: taskId,
      status: "active",
      currentStageId: "planning",
      activeSubtaskId: `${taskId}-1`,
      subtasks: [
        {
          id: `${taskId}-0`,
          stepId: "planning",
          name: "orchestrator_eval:planning",
          executionType: "agent",
          status: "completed",
          cost: zeroCost(),
          attempt: 1,
          maxRetries: 0,
          kind: "orchestrator_eval",
          stageId: "planning",
          startedAt: new Date("2026-04-06T01:00:00.000Z"),
          completedAt: new Date("2026-04-06T01:01:00.000Z"),
        },
        {
          id: `${taskId}-1`,
          stepId: "planning",
          name: "stage_agent_run:planning",
          executionType: "agent",
          status: "active",
          cost: zeroCost(),
          attempt: 1,
          maxRetries: 0,
          kind: "stage_agent_run",
          stageId: "planning",
          startedAt: new Date("2026-04-06T01:01:00.000Z"),
          // No completedAt -- interrupted
        },
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, task);

    // Write some pre-crash journal entries
    const { appendJournalEntry } = await import(
      "../../src/runtime/journal.js"
    );
    appendJournalEntry(runsDir, taskId, {
      type: "subtask_queued",
      subtaskId: `${taskId}-0`,
      kind: "orchestrator_eval",
    });
    appendJournalEntry(runsDir, taskId, {
      type: "subtask_started",
      subtaskId: `${taskId}-0`,
      kind: "orchestrator_eval",
    });
    appendJournalEntry(runsDir, taskId, {
      type: "subtask_completed",
      subtaskId: `${taskId}-0`,
      kind: "orchestrator_eval",
    });

    const preCrashJournal = readJournal(runsDir, taskId);
    const preCrashCount = preCrashJournal.length;
    expect(preCrashCount).toBe(3);

    // Run recovery which should append recovery-related entries
    const loadedTask = await loadTask(runsDir, taskId);
    expect(loadedTask).not.toBeNull();

    await rebuildQueueForActiveTask(runsDir, loadedTask!);

    // Read journal after recovery
    const postRecoveryJournal = readJournal(runsDir, taskId);

    // Pre-crash entries should still be present
    expect(postRecoveryJournal.length).toBeGreaterThanOrEqual(preCrashCount);

    // Entries should be in chronological order (timestamps non-decreasing)
    for (let i = 1; i < postRecoveryJournal.length; i++) {
      const prevTs = new Date(postRecoveryJournal[i - 1].timestamp).getTime();
      const currTs = new Date(postRecoveryJournal[i].timestamp).getTime();
      expect(currTs).toBeGreaterThanOrEqual(prevTs);
    }

    // The first 3 entries should match the pre-crash entries
    for (let i = 0; i < preCrashCount; i++) {
      expect(postRecoveryJournal[i].type).toBe(preCrashJournal[i].type);
      expect(postRecoveryJournal[i].subtaskId).toBe(
        preCrashJournal[i].subtaskId,
      );
    }
  });
});
