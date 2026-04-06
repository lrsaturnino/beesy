import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { appendJournalEntry, readJournal } from "../../src/runtime/journal.js";
import { checkTimeouts } from "../../src/runtime/pause-controller.js";
import type { Task, Subtask } from "../../src/queue/types.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-recovery-test-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
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

/** Factory for a minimal valid Task with overridable fields. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    gate: "test-gate",
    status: "queued",
    priority: "normal",
    position: 0,
    payload: { description: "test task" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    ...overrides,
  };
}

/** Factory for a completed subtask with all required fields. */
function createCompletedSubtask(overrides?: Partial<Subtask>): Subtask {
  return {
    id: "task-001-0",
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
    completedAt: new Date("2026-04-06T01:05:00.000Z"),
    ...overrides,
  };
}

/** Factory for an active (interrupted) subtask -- has startedAt but no completedAt. */
function createInterruptedSubtask(overrides?: Partial<Subtask>): Subtask {
  return {
    id: "task-001-1",
    stepId: "planning",
    name: "stage_agent_run:planning",
    executionType: "agent",
    status: "active",
    cost: zeroCost(),
    attempt: 1,
    maxRetries: 0,
    kind: "stage_agent_run",
    stageId: "planning",
    startedAt: new Date("2026-04-06T01:05:00.000Z"),
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Group 1: Recovery detects tasks by status
// -------------------------------------------------------------------

describe("Recovery detects tasks by status", () => {
  it("recovery detects active tasks from filesystem scan", async () => {
    await persistTask(
      runsDir,
      createTestTask({ id: "task-a", status: "active" }),
    );
    await persistTask(
      runsDir,
      createTestTask({ id: "task-b", status: "active" }),
    );
    await persistTask(
      runsDir,
      createTestTask({ id: "task-c", status: "completed" }),
    );

    const recovered = await recoverTasks(runsDir);
    const activeTasks = recovered.filter((t) => t.status === "active");

    expect(activeTasks).toHaveLength(2);
    const ids = activeTasks.map((t) => t.id).sort();
    expect(ids).toEqual(["task-a", "task-b"]);
  });

  it("recovery detects paused tasks with pause fields intact", async () => {
    const pausedAt = new Date("2026-04-06T02:00:00.000Z");
    const resumeDeadlineAt = new Date("2026-04-06T02:30:00.000Z");

    await persistTask(
      runsDir,
      createTestTask({
        id: "task-paused",
        status: "paused",
        pausedAt,
        resumeDeadlineAt,
        pauseReason: "awaiting review",
      }),
    );

    const recovered = await recoverTasks(runsDir);
    expect(recovered).toHaveLength(1);

    const task = recovered[0];
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBeInstanceOf(Date);
    expect(task.pausedAt!.getTime()).toBe(pausedAt.getTime());
    expect(task.resumeDeadlineAt).toBeInstanceOf(Date);
    expect(task.resumeDeadlineAt!.getTime()).toBe(resumeDeadlineAt.getTime());
  });

  it("recovery detects waiting tasks from filesystem scan", async () => {
    const waitingSince = new Date("2026-04-06T03:00:00.000Z");

    await persistTask(
      runsDir,
      createTestTask({
        id: "task-waiting",
        status: "waiting",
        waitingSince,
      }),
    );

    const recovered = await recoverTasks(runsDir);
    expect(recovered).toHaveLength(1);

    const task = recovered[0];
    expect(task.status).toBe("waiting");
    expect(task.waitingSince).toBeInstanceOf(Date);
    expect(task.waitingSince!.getTime()).toBe(waitingSince.getTime());
  });
});

// -------------------------------------------------------------------
// Group 2: Active task recovery logic
// -------------------------------------------------------------------

describe("Active task recovery re-enqueue logic", () => {
  it("re-enqueues from last interrupted subtask", async () => {
    const task = createTestTask({
      id: "task-active-001",
      status: "active",
      currentStageId: "planning",
      activeSubtaskId: "task-active-001-1",
      subtasks: [
        createCompletedSubtask({ id: "task-active-001-0" }),
        createInterruptedSubtask({ id: "task-active-001-1" }),
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, task);

    await rebuildQueueForActiveTask(runsDir, task);

    // The interrupted subtask should be marked failed (crashed)
    const interruptedSubtask = task.subtasks!.find(
      (s) => s.id === "task-active-001-1",
    );
    expect(interruptedSubtask!.status).toBe("failed");
    expect(interruptedSubtask!.completedAt).toBeInstanceOf(Date);

    // A new orchestrator_eval subtask should be enqueued for recovery
    expect(task.queuedSubtaskIds!.length).toBeGreaterThanOrEqual(1);
    const newSubtask = task.subtasks!.find(
      (s) => s.id === task.queuedSubtaskIds![0],
    );
    expect(newSubtask).toBeDefined();
    expect(newSubtask!.kind).toBe("orchestrator_eval");
    expect(newSubtask!.stageId).toBe("planning");

    // activeSubtaskId should be cleared
    expect(task.activeSubtaskId).toBeUndefined();
  });

  it("preserves queue when queued subtasks already exist", async () => {
    const pendingSubtask: Subtask = {
      id: "task-active-002-2",
      stepId: "planning",
      name: "orchestrator_eval:planning",
      executionType: "agent",
      status: "pending",
      cost: zeroCost(),
      attempt: 1,
      maxRetries: 0,
      kind: "orchestrator_eval",
      stageId: "planning",
    };

    const task = createTestTask({
      id: "task-active-002",
      status: "active",
      currentStageId: "planning",
      subtasks: [
        createCompletedSubtask({ id: "task-active-002-0" }),
        createCompletedSubtask({ id: "task-active-002-1" }),
        pendingSubtask,
      ],
      queuedSubtaskIds: ["task-active-002-2"],
    });
    await persistTask(runsDir, task);

    await rebuildQueueForActiveTask(runsDir, task);

    // Queue should be preserved as-is -- no additional subtasks
    expect(task.queuedSubtaskIds).toEqual(["task-active-002-2"]);
    // Subtask array unchanged (only the 3 original subtasks)
    expect(task.subtasks).toHaveLength(3);
  });

  it("enqueues orchestrator_eval when empty queue and no active subtask", async () => {
    const task = createTestTask({
      id: "task-active-003",
      status: "active",
      currentStageId: "coding",
      activeSubtaskId: undefined,
      subtasks: [
        createCompletedSubtask({ id: "task-active-003-0", stageId: "planning" }),
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, task);

    await rebuildQueueForActiveTask(runsDir, task);

    // A new orchestrator_eval should be enqueued for the current stage
    expect(task.queuedSubtaskIds!.length).toBe(1);
    const newSubtask = task.subtasks!.find(
      (s) => s.id === task.queuedSubtaskIds![0],
    );
    expect(newSubtask).toBeDefined();
    expect(newSubtask!.kind).toBe("orchestrator_eval");
    expect(newSubtask!.stageId).toBe("coding");
  });
});

// -------------------------------------------------------------------
// Group 3: Paused task recovery
// -------------------------------------------------------------------

describe("Paused task recovery", () => {
  it("maintains pause state when deadline has not expired", async () => {
    const futureDeadline = new Date(Date.now() + 1_800_000); // 30 min future
    const task = createTestTask({
      id: "task-paused-001",
      status: "paused",
      pausedAt: new Date(),
      resumeDeadlineAt: futureDeadline,
      pauseReason: "awaiting human review",
      currentStageId: "planning",
    });
    await persistTask(runsDir, task);

    await checkTimeouts(runsDir, [task]);

    expect(task.status).toBe("paused");

    // No task_waiting journal entry should exist
    const journal = readJournal(runsDir, task.id);
    const waitingEntries = journal.filter((e) => e.type === "task_waiting");
    expect(waitingEntries).toHaveLength(0);
  });

  it("transitions to waiting when deadline has expired", async () => {
    const pastDeadline = new Date(Date.now() - 600_000); // 10 min past
    const task = createTestTask({
      id: "task-paused-002",
      status: "paused",
      pausedAt: new Date(Date.now() - 2_400_000), // 40 min ago
      resumeDeadlineAt: pastDeadline,
      pauseReason: "awaiting human review",
      currentStageId: "planning",
    });
    await persistTask(runsDir, task);

    await checkTimeouts(runsDir, [task]);

    expect(task.status).toBe("waiting");
    expect(task.waitingSince).toBeInstanceOf(Date);

    // Journal should record the transition
    const journal = readJournal(runsDir, task.id);
    const waitingEntries = journal.filter((e) => e.type === "task_waiting");
    expect(waitingEntries).toHaveLength(1);
  });
});

// -------------------------------------------------------------------
// Group 4: Waiting task recovery
// -------------------------------------------------------------------

describe("Waiting task recovery", () => {
  it("leaves waiting tasks unchanged", async () => {
    const waitingSince = new Date("2026-04-06T03:00:00.000Z");
    const task = createTestTask({
      id: "task-waiting-001",
      status: "waiting",
      waitingSince,
      currentStageId: "planning",
    });
    await persistTask(runsDir, task);

    // Recovery should not modify waiting tasks
    const recovered = await recoverTasks(runsDir);
    const waitingTask = recovered.find((t) => t.id === "task-waiting-001");

    expect(waitingTask).toBeDefined();
    expect(waitingTask!.status).toBe("waiting");
    expect(waitingTask!.waitingSince!.getTime()).toBe(waitingSince.getTime());

    // No new journal entries should be created for waiting tasks
    const journal = readJournal(runsDir, task.id);
    expect(journal).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 5: Artifact registration
// -------------------------------------------------------------------

describe("Artifact registration journal entries", () => {
  it("artifact_registered entry contains durable ID, file path, and metadata", async () => {
    const taskId = "task-artifact-001";
    const task = createTestTask({ id: taskId, status: "active" });
    await persistTask(runsDir, task);

    // Write an artifact_registered journal entry (matching stage-agent-handler pattern)
    appendJournalEntry(runsDir, taskId, {
      type: "artifact_registered",
      artifactId: "550e8400-e29b-41d4-a716-446655440000",
      label: "planning_doc",
      format: "md",
      stageId: "planning",
    });

    // Read the journal and verify the entry
    const journal = readJournal(runsDir, taskId);
    expect(journal).toHaveLength(1);

    const entry = journal[0];
    expect(entry.type).toBe("artifact_registered");
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe("string");
    expect(entry.artifactId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(entry.label).toBe("planning_doc");
    expect(entry.format).toBe("md");
    expect(entry.stageId).toBe("planning");
  });
});

// -------------------------------------------------------------------
// Group 6: Determinism
// -------------------------------------------------------------------

describe("Recovery determinism", () => {
  it("same filesystem state produces same recovery actions", async () => {
    // Set up filesystem state with an interrupted active task
    const task1 = createTestTask({
      id: "task-determinism",
      status: "active",
      currentStageId: "planning",
      activeSubtaskId: "task-determinism-1",
      subtasks: [
        createCompletedSubtask({ id: "task-determinism-0" }),
        createInterruptedSubtask({ id: "task-determinism-1" }),
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, task1);

    // Run recovery first time
    await rebuildQueueForActiveTask(runsDir, task1);
    const firstQueueState = [...task1.queuedSubtaskIds!];
    const firstSubtasksLength = task1.subtasks!.length;

    // Reload the task from disk to restore original state
    const task2 = await loadTask(runsDir, "task-determinism");
    expect(task2).not.toBeNull();

    // Run recovery second time on the reloaded state
    await rebuildQueueForActiveTask(runsDir, task2!);
    const secondQueueState = [...task2!.queuedSubtaskIds!];
    const secondSubtasksLength = task2!.subtasks!.length;

    // Both recovery runs should produce the same structural result
    expect(firstQueueState.length).toBe(secondQueueState.length);
    expect(firstSubtasksLength).toBe(secondSubtasksLength);
  });
});

// -------------------------------------------------------------------
// Group 7: History immutability
// -------------------------------------------------------------------

describe("History immutability", () => {
  it("revisiting a stage creates new subtask record with new ID", async () => {
    const task = createTestTask({
      id: "task-revisit",
      status: "active",
      currentStageId: "planning",
      subtasks: [
        createCompletedSubtask({
          id: "task-revisit-0",
          kind: "orchestrator_eval",
          stageId: "planning",
        }),
        createCompletedSubtask({
          id: "task-revisit-1",
          kind: "stage_agent_run",
          stageId: "planning",
        }),
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, task);

    const originalSubtasks = task.subtasks!.map((s) => ({ ...s }));
    const originalLength = task.subtasks!.length;

    // Enqueue a new subtask for the same "planning" stage (re-entry)
    const newSubtask = await enqueueSubtask(runsDir, task, {
      kind: "orchestrator_eval",
      stageId: "planning",
    });

    // New subtask has a unique ID that differs from all prior subtasks
    expect(newSubtask.id).not.toBe("task-revisit-0");
    expect(newSubtask.id).not.toBe("task-revisit-1");

    // Subtasks array length increased by 1
    expect(task.subtasks!.length).toBe(originalLength + 1);

    // Prior subtask records remain unchanged
    for (let i = 0; i < originalLength; i++) {
      expect(task.subtasks![i].id).toBe(originalSubtasks[i].id);
      expect(task.subtasks![i].status).toBe(originalSubtasks[i].status);
      expect(task.subtasks![i].kind).toBe(originalSubtasks[i].kind);
    }
  });
});

// -------------------------------------------------------------------
// Group 8: Full recovery pipeline
// -------------------------------------------------------------------

describe("Full recovery pipeline (performRecovery)", () => {
  it("orchestrates recovery for active, paused, and waiting tasks", async () => {
    // Active task with interrupted subtask
    const activeTask = createTestTask({
      id: "task-full-active",
      status: "active",
      currentStageId: "planning",
      activeSubtaskId: "task-full-active-1",
      subtasks: [
        createCompletedSubtask({ id: "task-full-active-0" }),
        createInterruptedSubtask({ id: "task-full-active-1" }),
      ],
      queuedSubtaskIds: [],
    });
    await persistTask(runsDir, activeTask);

    // Paused task with expired deadline
    const pausedTask = createTestTask({
      id: "task-full-paused",
      status: "paused",
      pausedAt: new Date(Date.now() - 2_400_000),
      resumeDeadlineAt: new Date(Date.now() - 600_000),
      pauseReason: "expired pause",
      currentStageId: "planning",
    });
    await persistTask(runsDir, pausedTask);

    // Waiting task
    const waitingTask = createTestTask({
      id: "task-full-waiting",
      status: "waiting",
      waitingSince: new Date("2026-04-06T03:00:00.000Z"),
      currentStageId: "coding",
    });
    await persistTask(runsDir, waitingTask);

    // Completed task (should NOT be recovered)
    await persistTask(
      runsDir,
      createTestTask({ id: "task-full-done", status: "completed" }),
    );

    // Run full recovery pipeline
    const result = await performRecovery(runsDir);

    // Should return categorized tasks
    expect(result.active.length).toBeGreaterThanOrEqual(1);
    expect(result.waiting.length).toBeGreaterThanOrEqual(1);

    // Active task should have its queue rebuilt
    const recoveredActive = result.active.find(
      (t) => t.id === "task-full-active",
    );
    expect(recoveredActive).toBeDefined();
    expect(recoveredActive!.queuedSubtaskIds!.length).toBeGreaterThanOrEqual(1);

    // Paused task with expired deadline should transition to waiting
    // (it may be in result.waiting now)
    const allTasks = [...result.active, ...result.paused, ...result.waiting];
    const recoveredPaused = allTasks.find(
      (t) => t.id === "task-full-paused",
    );
    expect(recoveredPaused).toBeDefined();
    expect(recoveredPaused!.status).toBe("waiting");

    // Waiting task should remain in waiting
    const recoveredWaiting = allTasks.find(
      (t) => t.id === "task-full-waiting",
    );
    expect(recoveredWaiting).toBeDefined();
    expect(recoveredWaiting!.status).toBe("waiting");
  });
});
