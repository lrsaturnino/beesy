import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  persistTask,
  loadTask,
  enqueueSubtask,
  dequeueNext,
  markSubtaskActive,
  markSubtaskComplete,
  markSubtaskFailed,
  recoverTasks,
} from "../../src/runtime/task-state.js";
import type { Task, Subtask } from "../../src/queue/types.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-task-state-test-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
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

/** Factory for a subtask definition used with enqueueSubtask. */
function createSubtaskDef(overrides?: Record<string, unknown>) {
  return {
    kind: "orchestrator_eval" as const,
    stageId: "planning",
    payload: { description: "evaluate next action" },
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Group 1: persistTask -- Atomic Write
// -------------------------------------------------------------------

describe("persistTask -- Atomic Write", () => {
  it("writes task.json to correct directory structure", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const taskJsonPath = path.join(runsDir, task.id, "task.json");
    const raw = await readFile(taskJsonPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.id).toBe("task-001");
    expect(parsed.status).toBe("queued");
    expect(parsed.gate).toBe("test-gate");
  });

  it("creates nested directory structure on first write", async () => {
    const task = createTestTask({ id: "nested-task" });
    await persistTask(runsDir, task);

    const taskJsonPath = path.join(runsDir, "nested-task", "task.json");
    const raw = await readFile(taskJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("nested-task");
  });

  it("overwrites existing task.json on subsequent writes", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    task.status = "active";
    task.startedAt = new Date("2026-04-06T01:00:00.000Z");
    await persistTask(runsDir, task);

    const raw = await readFile(path.join(runsDir, task.id, "task.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("active");
  });

  it("serializes Date fields as ISO strings", async () => {
    const task = createTestTask({
      startedAt: new Date("2026-04-06T01:00:00.000Z"),
      completedAt: new Date("2026-04-06T02:00:00.000Z"),
      pausedAt: new Date("2026-04-06T01:30:00.000Z"),
      waitingSince: new Date("2026-04-06T01:45:00.000Z"),
      resumeDeadlineAt: new Date("2026-04-06T03:00:00.000Z"),
    });
    await persistTask(runsDir, task);

    const raw = await readFile(path.join(runsDir, task.id, "task.json"), "utf-8");
    const parsed = JSON.parse(raw);

    expect(typeof parsed.createdAt).toBe("string");
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof parsed.startedAt).toBe("string");
    expect(typeof parsed.completedAt).toBe("string");
    expect(typeof parsed.pausedAt).toBe("string");
    expect(typeof parsed.waitingSince).toBe("string");
    expect(typeof parsed.resumeDeadlineAt).toBe("string");
  });

  it("writes atomically using temp file and rename", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const taskDir = path.join(runsDir, task.id);
    const entries = await readdir(taskDir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
    expect(entries).toContain("task.json");
  });
});

// -------------------------------------------------------------------
// Group 2: loadTask -- Deserialization
// -------------------------------------------------------------------

describe("loadTask -- Deserialization", () => {
  it("reads and deserializes task from task.json", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("task-001");
    expect(loaded!.status).toBe("queued");
    expect(loaded!.gate).toBe("test-gate");
    expect(loaded!.priority).toBe("normal");
    expect(loaded!.requestedBy).toBe("user-1");
  });

  it("restores Date objects from ISO strings", async () => {
    const task = createTestTask({
      startedAt: new Date("2026-04-06T01:00:00.000Z"),
      completedAt: new Date("2026-04-06T02:00:00.000Z"),
      pausedAt: new Date("2026-04-06T01:30:00.000Z"),
      waitingSince: new Date("2026-04-06T01:45:00.000Z"),
      resumeDeadlineAt: new Date("2026-04-06T03:00:00.000Z"),
    });
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.createdAt).toBeInstanceOf(Date);
    expect(loaded!.createdAt.getTime()).toBe(task.createdAt.getTime());
    expect(loaded!.startedAt).toBeInstanceOf(Date);
    expect(loaded!.startedAt!.getTime()).toBe(task.startedAt!.getTime());
    expect(loaded!.completedAt).toBeInstanceOf(Date);
    expect(loaded!.pausedAt).toBeInstanceOf(Date);
    expect(loaded!.waitingSince).toBeInstanceOf(Date);
    expect(loaded!.resumeDeadlineAt).toBeInstanceOf(Date);
  });

  it("handles optional Date fields that are undefined", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.createdAt).toBeInstanceOf(Date);
    expect(loaded!.startedAt).toBeUndefined();
    expect(loaded!.completedAt).toBeUndefined();
    expect(loaded!.pausedAt).toBeUndefined();
    expect(loaded!.waitingSince).toBeUndefined();
    expect(loaded!.resumeDeadlineAt).toBeUndefined();
  });

  it("returns null for nonexistent task", async () => {
    const loaded = await loadTask(runsDir, "nonexistent-task");
    expect(loaded).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 3: Persistence Roundtrip
// -------------------------------------------------------------------

describe("Persistence Roundtrip", () => {
  it("write then read produces identical state", async () => {
    const task = createTestTask({
      startedAt: new Date("2026-04-06T01:00:00.000Z"),
      workspacePath: "/tmp/workspace",
      error: "test error",
      cronJobId: "cron-1",
    });
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(task.id);
    expect(loaded!.gate).toBe(task.gate);
    expect(loaded!.status).toBe(task.status);
    expect(loaded!.priority).toBe(task.priority);
    expect(loaded!.position).toBe(task.position);
    expect(loaded!.payload).toEqual(task.payload);
    expect(loaded!.requestedBy).toBe(task.requestedBy);
    expect(loaded!.sourceChannel).toEqual(task.sourceChannel);
    expect(loaded!.createdAt.getTime()).toBe(task.createdAt.getTime());
    expect(loaded!.startedAt!.getTime()).toBe(task.startedAt!.getTime());
    expect(loaded!.cost).toEqual(task.cost);
    expect(loaded!.workspacePath).toBe(task.workspacePath);
    expect(loaded!.error).toBe(task.error);
    expect(loaded!.cronJobId).toBe(task.cronJobId);
  });

  it("roundtrip preserves subtask array", async () => {
    const subtasks: Subtask[] = [
      {
        id: "task-001-0",
        stepId: "step-1",
        name: "Planning",
        executionType: "agent",
        status: "completed",
        cost: zeroCost(),
        attempt: 1,
        maxRetries: 2,
        startedAt: new Date("2026-04-06T01:00:00.000Z"),
        completedAt: new Date("2026-04-06T01:10:00.000Z"),
        kind: "orchestrator_eval",
        stageId: "planning",
      },
      {
        id: "task-001-1",
        stepId: "step-2",
        name: "Execution",
        executionType: "agent",
        status: "active",
        cost: zeroCost(),
        attempt: 1,
        maxRetries: 3,
        startedAt: new Date("2026-04-06T01:10:00.000Z"),
        kind: "stage_agent_run",
        stageId: "coding",
      },
      {
        id: "task-001-2",
        stepId: "step-3",
        name: "Review",
        executionType: "agent",
        status: "pending",
        cost: zeroCost(),
        attempt: 1,
        maxRetries: 1,
      },
    ];
    const task = createTestTask({ subtasks });
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.subtasks).toHaveLength(3);
    expect(loaded!.subtasks![0].id).toBe("task-001-0");
    expect(loaded!.subtasks![0].status).toBe("completed");
    expect(loaded!.subtasks![0].startedAt).toBeInstanceOf(Date);
    expect(loaded!.subtasks![0].completedAt).toBeInstanceOf(Date);
    expect(loaded!.subtasks![1].status).toBe("active");
    expect(loaded!.subtasks![1].kind).toBe("stage_agent_run");
    expect(loaded!.subtasks![1].startedAt).toBeInstanceOf(Date);
    expect(loaded!.subtasks![2].status).toBe("pending");
    expect(loaded!.subtasks![2].startedAt).toBeUndefined();
  });

  it("roundtrip preserves recipe-oriented fields", async () => {
    const task = createTestTask({
      recipeId: "new-implementation",
      currentStageId: "planning",
      activeSubtaskId: "task-001-0",
      queuedSubtaskIds: ["task-001-1", "task-001-2"],
      artifactIds: ["artifact-a", "artifact-b"],
      stageRetryCount: { planning: 1, coding: 0 },
      totalActionCount: 5,
      pauseReason: "awaiting human approval",
      capturedHumanContext: "user said yes",
    });
    await persistTask(runsDir, task);

    const loaded = await loadTask(runsDir, task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.recipeId).toBe("new-implementation");
    expect(loaded!.currentStageId).toBe("planning");
    expect(loaded!.activeSubtaskId).toBe("task-001-0");
    expect(loaded!.queuedSubtaskIds).toEqual(["task-001-1", "task-001-2"]);
    expect(loaded!.artifactIds).toEqual(["artifact-a", "artifact-b"]);
    expect(loaded!.stageRetryCount).toEqual({ planning: 1, coding: 0 });
    expect(loaded!.totalActionCount).toBe(5);
    expect(loaded!.pauseReason).toBe("awaiting human approval");
    expect(loaded!.capturedHumanContext).toBe("user said yes");
  });
});

// -------------------------------------------------------------------
// Group 4: enqueueSubtask
// -------------------------------------------------------------------

describe("enqueueSubtask", () => {
  it("creates subtask with stable ID", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    expect(subtask.id).toMatch(/^task-001-/);

    const subtask2 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    expect(subtask2.id).toMatch(/^task-001-/);
    expect(subtask2.id).not.toBe(subtask.id);
  });

  it("sets lifecycle timestamps on creation", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const beforeEnqueue = Date.now();
    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    const afterEnqueue = Date.now();

    expect(subtask.status).toBe("pending");
    expect(subtask.startedAt).toBeUndefined();
    expect(subtask.completedAt).toBeUndefined();
    expect(subtask.attempt).toBe(1);
  });

  it("appends subtask ID to queuedSubtaskIds", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const s1 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    const s2 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    const s3 = await enqueueSubtask(runsDir, task, createSubtaskDef());

    expect(task.queuedSubtaskIds).toHaveLength(3);
    expect(task.queuedSubtaskIds![0]).toBe(s1.id);
    expect(task.queuedSubtaskIds![1]).toBe(s2.id);
    expect(task.queuedSubtaskIds![2]).toBe(s3.id);
  });

  it("sets correct kind, stageId, and attempt counter", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, {
      kind: "stage_agent_run" as const,
      stageId: "coding",
      payload: { source: "test" },
    });

    expect(subtask.kind).toBe("stage_agent_run");
    expect(subtask.stageId).toBe("coding");
    expect(subtask.attempt).toBe(1);
  });

  it("writes subtask record to subtasks/ directory", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());

    const subtaskPath = path.join(
      runsDir,
      task.id,
      "subtasks",
      `${subtask.id}.json`,
    );
    const raw = await readFile(subtaskPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(subtask.id);
    expect(parsed.status).toBe("pending");
  });

  it("preserves payload in subtask record", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const customPayload = { description: "evaluate architecture", source: "task.payload" };
    const subtask = await enqueueSubtask(runsDir, task, {
      ...createSubtaskDef(),
      payload: customPayload,
    });

    const subtaskPath = path.join(
      runsDir,
      task.id,
      "subtasks",
      `${subtask.id}.json`,
    );
    const raw = await readFile(subtaskPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.payload).toEqual(customPayload);
  });
});

// -------------------------------------------------------------------
// Group 5: dequeueNext -- FIFO Ordering
// -------------------------------------------------------------------

describe("dequeueNext -- FIFO Ordering", () => {
  it("returns first queued subtask", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const s1 = await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "stage-a" }));
    await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "stage-b" }));
    await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "stage-c" }));

    const next = await dequeueNext(runsDir, task);
    expect(next).not.toBeNull();
    expect(next!.id).toBe(s1.id);
  });

  it("removes dequeued subtask from queuedSubtaskIds", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const s1 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    const s2 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    expect(task.queuedSubtaskIds).toHaveLength(2);

    await dequeueNext(runsDir, task);
    expect(task.queuedSubtaskIds).toHaveLength(1);
    expect(task.queuedSubtaskIds).not.toContain(s1.id);
    expect(task.queuedSubtaskIds).toContain(s2.id);
  });

  it("maintains FIFO order across multiple dequeues", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const s1 = await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "A" }));
    const s2 = await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "B" }));
    const s3 = await enqueueSubtask(runsDir, task, createSubtaskDef({ stageId: "C" }));

    const d1 = await dequeueNext(runsDir, task);
    const d2 = await dequeueNext(runsDir, task);
    const d3 = await dequeueNext(runsDir, task);

    expect(d1!.id).toBe(s1.id);
    expect(d2!.id).toBe(s2.id);
    expect(d3!.id).toBe(s3.id);
  });

  it("returns null when queue is empty", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const result = await dequeueNext(runsDir, task);
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 6: Subtask Lifecycle Transitions
// -------------------------------------------------------------------

describe("Subtask Lifecycle Transitions", () => {
  it("markSubtaskActive sets status and startedAt", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    await markSubtaskActive(runsDir, task, subtask.id);

    const updated = task.subtasks!.find((s) => s.id === subtask.id)!;
    expect(updated.status).toBe("active");
    expect(updated.startedAt).toBeInstanceOf(Date);
    expect(task.activeSubtaskId).toBe(subtask.id);
  });

  it("markSubtaskComplete sets status and completedAt", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    await markSubtaskActive(runsDir, task, subtask.id);
    await markSubtaskComplete(runsDir, task, subtask.id, "output data");

    const updated = task.subtasks!.find((s) => s.id === subtask.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.output).toBe("output data");
  });

  it("markSubtaskFailed sets status, completedAt, and error", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    await markSubtaskActive(runsDir, task, subtask.id);
    await markSubtaskFailed(runsDir, task, subtask.id, "agent timeout");

    const updated = task.subtasks!.find((s) => s.id === subtask.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.error).toBe("agent timeout");
  });

  it("lifecycle transitions persist to subtask file", async () => {
    const task = createTestTask();
    await persistTask(runsDir, task);

    const subtask = await enqueueSubtask(runsDir, task, createSubtaskDef());
    await markSubtaskActive(runsDir, task, subtask.id);
    await markSubtaskComplete(runsDir, task, subtask.id, "done");

    const subtaskPath = path.join(
      runsDir,
      task.id,
      "subtasks",
      `${subtask.id}.json`,
    );
    const raw = await readFile(subtaskPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe("completed");
    expect(typeof parsed.startedAt).toBe("string");
    expect(typeof parsed.completedAt).toBe("string");
    expect(parsed.output).toBe("done");
  });

  it("task and subtask status are independently queryable", async () => {
    const task = createTestTask({ status: "active" });
    await persistTask(runsDir, task);

    const s1 = await enqueueSubtask(runsDir, task, createSubtaskDef());
    const s2 = await enqueueSubtask(runsDir, task, createSubtaskDef());

    await markSubtaskActive(runsDir, task, s1.id);
    await markSubtaskComplete(runsDir, task, s1.id);

    const pending = task.subtasks!.find((s) => s.id === s2.id)!;
    const completed = task.subtasks!.find((s) => s.id === s1.id)!;

    expect(task.status).toBe("active");
    expect(pending.status).toBe("pending");
    expect(completed.status).toBe("completed");
  });
});

// -------------------------------------------------------------------
// Group 7: recoverTasks -- Directory Scan
// -------------------------------------------------------------------

describe("recoverTasks -- Directory Scan", () => {
  it("scans runs directory for task.json files", async () => {
    await persistTask(runsDir, createTestTask({ id: "task-a", status: "active" }));
    await persistTask(runsDir, createTestTask({ id: "task-b", status: "active" }));
    await persistTask(runsDir, createTestTask({ id: "task-c", status: "active" }));

    const recovered = await recoverTasks(runsDir);
    expect(recovered).toHaveLength(3);

    const ids = recovered.map((t) => t.id).sort();
    expect(ids).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("filters to active, paused, and waiting tasks only", async () => {
    await persistTask(runsDir, createTestTask({ id: "t-active", status: "active" }));
    await persistTask(runsDir, createTestTask({ id: "t-paused", status: "paused" }));
    await persistTask(runsDir, createTestTask({ id: "t-waiting", status: "waiting" }));
    await persistTask(runsDir, createTestTask({ id: "t-completed", status: "completed" }));
    await persistTask(runsDir, createTestTask({ id: "t-failed", status: "failed" }));

    const recovered = await recoverTasks(runsDir);
    expect(recovered).toHaveLength(3);

    const statuses = recovered.map((t) => t.status).sort();
    expect(statuses).toEqual(["active", "paused", "waiting"]);
  });

  it("returns empty array for empty or nonexistent runs directory", async () => {
    const emptyResult = await recoverTasks(runsDir);
    expect(emptyResult).toEqual([]);

    const nonexistentResult = await recoverTasks(
      path.join(runsDir, "does-not-exist"),
    );
    expect(nonexistentResult).toEqual([]);
  });

  it("deserializes Date fields correctly in recovered tasks", async () => {
    const task = createTestTask({
      id: "task-dated",
      status: "active",
      startedAt: new Date("2026-04-06T01:00:00.000Z"),
      pausedAt: new Date("2026-04-06T01:30:00.000Z"),
    });
    await persistTask(runsDir, task);

    const recovered = await recoverTasks(runsDir);
    expect(recovered).toHaveLength(1);

    const rt = recovered[0];
    expect(rt.createdAt).toBeInstanceOf(Date);
    expect(rt.createdAt.getTime()).toBe(task.createdAt.getTime());
    expect(rt.startedAt).toBeInstanceOf(Date);
    expect(rt.startedAt!.getTime()).toBe(task.startedAt!.getTime());
    expect(rt.pausedAt).toBeInstanceOf(Date);
    expect(rt.pausedAt!.getTime()).toBe(task.pausedAt!.getTime());
  });
});
