/**
 * Filesystem-based task state persistence and per-task subtask queue operations.
 *
 * Manages durable task state under `runtime/runs/<task-id>/` with atomic
 * writes (temp file + rename), Date serialization roundtrips, FIFO subtask
 * queue ordering, and startup recovery scanning. This module is the
 * persistence foundation consumed by the worker loop, recovery, pause
 * controller, and journal subsystems.
 *
 * @module runtime/task-state
 */

import { writeFile, readFile, rename, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { Task, Subtask, SubtaskKind } from "../queue/types.js";
import { appendJournalEntry } from "./journal.js";
import { checkTimeouts } from "./pause-controller.js";

// ---------------------------------------------------------------------------
// Subtask definition input type
// ---------------------------------------------------------------------------

/** Input definition for creating a new subtask via {@link enqueueSubtask}. */
export interface SubtaskDef {
  /** Dispatch kind for the worker loop. */
  kind: SubtaskKind;
  /** Recipe stage this subtask belongs to. */
  stageId: string;
  /** Resolved input data for execution. */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal path helpers
// ---------------------------------------------------------------------------

/** Absolute path to a task's run directory. */
function taskDir(runsDir: string, taskId: string): string {
  return path.join(runsDir, taskId);
}

/** Absolute path to a task's subtasks directory. */
function subtasksDir(runsDir: string, taskId: string): string {
  return path.join(runsDir, taskId, "subtasks");
}

// ---------------------------------------------------------------------------
// Date field lists for serialization roundtrips
// ---------------------------------------------------------------------------

/** Task-level fields that hold Date objects requiring ISO string conversion. */
const TASK_DATE_FIELDS = [
  "createdAt",
  "startedAt",
  "completedAt",
  "pausedAt",
  "waitingSince",
  "resumeDeadlineAt",
] as const;

/** Subtask-level fields that hold Date objects requiring ISO string conversion. */
const SUBTASK_DATE_FIELDS = ["startedAt", "completedAt"] as const;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Task to a JSON-safe plain object, transforming Date fields to
 * ISO-8601 strings. Subtasks embedded in the task are also serialized.
 */
function serializeTask(task: Task): Record<string, unknown> {
  const data: Record<string, unknown> = { ...task };

  for (const field of TASK_DATE_FIELDS) {
    const value = task[field];
    if (value instanceof Date) {
      data[field] = value.toISOString();
    }
  }

  if (task.subtasks) {
    data.subtasks = task.subtasks.map(serializeSubtask);
  }

  return data;
}

/** Convert a Subtask to a JSON-safe plain object with Date fields as ISO strings. */
function serializeSubtask(subtask: Subtask): Record<string, unknown> {
  const data: Record<string, unknown> = { ...subtask };

  for (const field of SUBTASK_DATE_FIELDS) {
    const value = subtask[field];
    if (value instanceof Date) {
      data[field] = value.toISOString();
    }
  }

  return data;
}

/**
 * Restore a Task from a parsed JSON object, converting ISO-8601 date strings
 * back to Date instances. Embedded subtasks are also deserialized.
 */
function deserializeTask(data: Record<string, unknown>): Task {
  const task: Record<string, unknown> = { ...data };

  // Restore required Date field
  task.createdAt = new Date(data.createdAt as string);

  // Restore optional Date fields only when present
  for (const field of TASK_DATE_FIELDS) {
    if (field === "createdAt") continue;
    if (data[field]) {
      task[field] = new Date(data[field] as string);
    } else {
      delete task[field];
    }
  }

  if (Array.isArray(data.subtasks)) {
    task.subtasks = (data.subtasks as Record<string, unknown>[]).map(
      deserializeSubtask,
    );
  }

  return task as unknown as Task;
}

/** Restore a Subtask from a parsed JSON object with Date fields as Date instances. */
function deserializeSubtask(data: Record<string, unknown>): Subtask {
  const subtask: Record<string, unknown> = { ...data };

  for (const field of SUBTASK_DATE_FIELDS) {
    if (data[field]) {
      subtask[field] = new Date(data[field] as string);
    } else {
      delete subtask[field];
    }
  }

  return subtask as unknown as Subtask;
}

// ---------------------------------------------------------------------------
// Subtask ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, unique subtask identifier using the task ID and the
 * current length of the task's subtasks array as a monotonic counter.
 */
function generateSubtaskId(task: Task): string {
  const counter = task.subtasks?.length ?? 0;
  return `${task.id}-${counter}`;
}

// ---------------------------------------------------------------------------
// Recoverable task statuses for startup recovery scanning
// ---------------------------------------------------------------------------

/** Task statuses eligible for recovery on startup (non-terminal, non-queued). */
const RECOVERABLE_STATUSES = new Set(["active", "paused", "waiting"]);

// ---------------------------------------------------------------------------
// Internal subtask helpers
// ---------------------------------------------------------------------------

/**
 * Look up a subtask by ID in the parent task's subtasks array.
 * Throws a descriptive error when the subtask is not found, preventing
 * silent failures in lifecycle transitions.
 */
function findSubtaskOrThrow(task: Task, subtaskId: string): Subtask {
  const subtask = task.subtasks?.find((s) => s.id === subtaskId);
  if (!subtask) {
    throw new Error(`Subtask not found: ${subtaskId} in task ${task.id}`);
  }
  return subtask;
}

/**
 * Write a subtask record to its individual JSON file under the subtasks/
 * directory and persist the updated parent task state. Centralizes the
 * write-subtask-then-persist-task pattern shared by enqueue and all
 * lifecycle transition functions.
 */
async function persistSubtask(
  runsDir: string,
  task: Task,
  subtask: Subtask,
): Promise<void> {
  const subDir = subtasksDir(runsDir, task.id);
  await mkdir(subDir, { recursive: true });
  const subtaskJson = JSON.stringify(serializeSubtask(subtask), null, 2);
  await writeFile(
    path.join(subDir, `${subtask.id}.json`),
    subtaskJson,
    "utf-8",
  );
  await persistTask(runsDir, task);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a task state snapshot to disk atomically.
 *
 * Writes to a temporary file first, then renames to `task.json` so that
 * readers never observe a partially-written file. Creates the task run
 * directory if it does not already exist.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param task    - Task state to persist
 */
export async function persistTask(runsDir: string, task: Task): Promise<void> {
  const dir = taskDir(runsDir, task.id);
  await mkdir(dir, { recursive: true });

  const json = JSON.stringify(serializeTask(task), null, 2);
  const tmpPath = path.join(dir, `task.json.${Date.now()}.tmp`);
  const finalPath = path.join(dir, "task.json");

  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, finalPath);
}

/**
 * Load a task state snapshot from disk.
 *
 * Reads `task.json` from the task's run directory and deserializes it,
 * restoring Date objects from ISO-8601 strings. Returns null if the task
 * directory or file does not exist.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the task to load
 * @returns The deserialized Task, or null if not found
 */
export async function loadTask(
  runsDir: string,
  taskId: string,
): Promise<Task | null> {
  const filePath = path.join(taskDir(runsDir, taskId), "task.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return deserializeTask(data);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Create and enqueue a new subtask for the given task.
 *
 * Generates a stable subtask ID, initializes lifecycle fields, appends the
 * subtask to the task's in-memory arrays, writes the subtask record to its
 * own JSON file under `subtasks/`, and persists the updated task state.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param task    - Parent task (mutated in place with the new subtask)
 * @param def     - Subtask definition specifying kind, stageId, and payload
 * @returns The newly created Subtask
 */
export async function enqueueSubtask(
  runsDir: string,
  task: Task,
  def: SubtaskDef,
): Promise<Subtask> {
  const subtaskId = generateSubtaskId(task);

  const subtask: Subtask = {
    id: subtaskId,
    stepId: def.stageId,
    name: `${def.kind}:${def.stageId}`,
    executionType: "agent",
    status: "pending",
    cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    attempt: 1,
    maxRetries: 0,
    kind: def.kind,
    stageId: def.stageId,
    payload: def.payload,
  };

  // Update task in-memory state
  if (!task.subtasks) task.subtasks = [];
  task.subtasks.push(subtask);

  if (!task.queuedSubtaskIds) task.queuedSubtaskIds = [];
  task.queuedSubtaskIds.push(subtaskId);

  // Write subtask file and persist updated task state
  await persistSubtask(runsDir, task, subtask);

  return subtask;
}

/**
 * Dequeue the next subtask from the front of the task's pending queue.
 *
 * Removes the first entry from `queuedSubtaskIds` and returns the
 * corresponding Subtask from the task's subtasks array. Returns null if
 * the queue is empty.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param task    - Parent task (mutated in place by removing from queue)
 * @returns The dequeued Subtask, or null if queue is empty
 */
export async function dequeueNext(
  runsDir: string,
  task: Task,
): Promise<Subtask | null> {
  if (!task.queuedSubtaskIds || task.queuedSubtaskIds.length === 0) {
    return null;
  }

  const subtaskId = task.queuedSubtaskIds.shift()!;
  const subtask = task.subtasks?.find((s) => s.id === subtaskId) ?? null;

  // Persist the updated queue state
  await persistTask(runsDir, task);

  return subtask;
}

/**
 * Transition a subtask to active status.
 *
 * Sets the subtask status to "active", records the start timestamp, and
 * updates the parent task's `activeSubtaskId`. Persists both the subtask
 * file and the updated task state.
 *
 * @param runsDir   - Base directory containing all task run directories
 * @param task      - Parent task (mutated in place)
 * @param subtaskId - Identifier of the subtask to activate
 */
export async function markSubtaskActive(
  runsDir: string,
  task: Task,
  subtaskId: string,
): Promise<void> {
  const subtask = findSubtaskOrThrow(task, subtaskId);

  subtask.status = "active";
  subtask.startedAt = new Date();
  task.activeSubtaskId = subtaskId;

  await persistSubtask(runsDir, task, subtask);
}

/**
 * Transition a subtask to completed status.
 *
 * Sets the subtask status to "completed", records the completion timestamp,
 * optionally stores output data, and clears the parent task's
 * `activeSubtaskId`. Persists both the subtask file and task state.
 *
 * @param runsDir   - Base directory containing all task run directories
 * @param task      - Parent task (mutated in place)
 * @param subtaskId - Identifier of the subtask to complete
 * @param output    - Optional text output produced by the subtask execution
 */
export async function markSubtaskComplete(
  runsDir: string,
  task: Task,
  subtaskId: string,
  output?: string,
): Promise<void> {
  const subtask = findSubtaskOrThrow(task, subtaskId);

  subtask.status = "completed";
  subtask.completedAt = new Date();
  if (output !== undefined) {
    subtask.output = output;
  }
  task.activeSubtaskId = undefined;

  await persistSubtask(runsDir, task, subtask);
}

/**
 * Transition a subtask to failed status.
 *
 * Sets the subtask status to "failed", records the completion timestamp and
 * error message, and clears the parent task's `activeSubtaskId`. Persists
 * both the subtask file and task state.
 *
 * @param runsDir   - Base directory containing all task run directories
 * @param task      - Parent task (mutated in place)
 * @param subtaskId - Identifier of the subtask that failed
 * @param error     - Error message describing the failure
 */
export async function markSubtaskFailed(
  runsDir: string,
  task: Task,
  subtaskId: string,
  error: string,
): Promise<void> {
  const subtask = findSubtaskOrThrow(task, subtaskId);

  subtask.status = "failed";
  subtask.completedAt = new Date();
  subtask.error = error;
  task.activeSubtaskId = undefined;

  await persistSubtask(runsDir, task, subtask);
}

/**
 * Scan the runs directory for tasks that need recovery on startup.
 *
 * Reads every `task.json` under the runs directory, deserializes each one,
 * and returns only those with status "active", "paused", or "waiting". Tasks
 * in terminal states (completed, failed, aborted, queued) are excluded.
 *
 * Returns an empty array if the directory does not exist or is empty.
 *
 * @param runsDir - Base directory containing all task run directories
 * @returns Array of recoverable tasks
 */
export async function recoverTasks(runsDir: string): Promise<Task[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const tasks: Task[] = [];

  for (const entry of entries) {
    const task = await loadTask(runsDir, entry);
    if (task && RECOVERABLE_STATUSES.has(task.status)) {
      tasks.push(task);
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Recovery logic for active tasks
// ---------------------------------------------------------------------------

/** Standard error message for subtasks interrupted by a process crash. */
const CRASH_RECOVERY_ERROR =
  "Process crashed during subtask execution (recovered on startup)";

/**
 * Resolve the interrupted subtask for an active task, if any.
 *
 * Looks up the task's `activeSubtaskId` in the subtask array and returns it
 * only when it was genuinely interrupted: has `startedAt` but no `completedAt`.
 * Returns null for all other cases (no active subtask, subtask not found,
 * subtask already completed).
 *
 * @param task - Active task whose subtask state to inspect
 * @returns The interrupted subtask, or null if none qualifies
 */
function findInterruptedSubtask(task: Task): Subtask | null {
  if (!task.activeSubtaskId) return null;

  const candidate = task.subtasks?.find(
    (s) => s.id === task.activeSubtaskId,
  );

  if (candidate && candidate.startedAt && !candidate.completedAt) {
    return candidate;
  }

  return null;
}

/**
 * Rebuild the subtask queue for an active task that was interrupted by a
 * process crash or restart.
 *
 * Applies recovery in two sequential phases:
 *
 * **Phase 1 -- Triage**: If the queue already has entries, the task's
 * execution state is intact and no recovery is needed (early return). If
 * `activeSubtaskId` references an interrupted subtask (started but never
 * completed), that subtask is marked as failed and the active reference
 * is cleared.
 *
 * **Phase 2 -- Re-entry**: If `currentStageId` is set, a fresh
 * `orchestrator_eval` subtask is enqueued so the worker loop can resume
 * from the correct stage.
 *
 * All mutations are persisted to disk and journaled for recovery auditability.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param task    - Active task to recover (mutated in place)
 */
export async function rebuildQueueForActiveTask(
  runsDir: string,
  task: Task,
): Promise<void> {
  // Queue is already populated -- execution state is intact
  if (task.queuedSubtaskIds && task.queuedSubtaskIds.length > 0) {
    return;
  }

  // Phase 1: Handle any interrupted subtask from the crash
  const interrupted = findInterruptedSubtask(task);

  if (interrupted) {
    await markSubtaskFailed(runsDir, task, interrupted.id, CRASH_RECOVERY_ERROR);

    appendJournalEntry(runsDir, task.id, {
      type: "subtask_failed",
      subtaskId: interrupted.id,
      error: CRASH_RECOVERY_ERROR,
      recovered: true,
    });
  } else if (task.activeSubtaskId) {
    // Active subtask reference exists but the subtask record is missing or
    // already completed -- clear the stale reference so Phase 2 can proceed
    task.activeSubtaskId = undefined;
    await persistTask(runsDir, task);
  }

  // Phase 2: Enqueue a fresh orchestrator_eval for the current stage
  if (task.currentStageId) {
    const newSubtask = await enqueueSubtask(runsDir, task, {
      kind: "orchestrator_eval",
      stageId: task.currentStageId,
    });

    appendJournalEntry(runsDir, task.id, {
      type: "subtask_queued",
      subtaskId: newSubtask.id,
      kind: "orchestrator_eval",
      stageId: task.currentStageId,
      recovered: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Full recovery pipeline
// ---------------------------------------------------------------------------

/** Categorized recovery results grouped by post-recovery task status. */
export interface RecoveryResult {
  /** Active tasks with rebuilt subtask queues, ready for worker processing. */
  active: Task[];
  /** Paused tasks still within their resume deadline. */
  paused: Task[];
  /** Tasks awaiting operator intervention (originally waiting or expired paused). */
  waiting: Task[];
}

/**
 * Partition an array of tasks into status-keyed buckets.
 *
 * Groups tasks by their current `status` field into the three recovery
 * categories. Tasks whose status does not match any category are silently
 * excluded (they should not appear in recovery results).
 */
function categorizeByStatus(tasks: Task[]): RecoveryResult {
  const result: RecoveryResult = { active: [], paused: [], waiting: [] };

  for (const task of tasks) {
    if (task.status === "active") {
      result.active.push(task);
    } else if (task.status === "paused") {
      result.paused.push(task);
    } else if (task.status === "waiting") {
      result.waiting.push(task);
    }
  }

  return result;
}

/**
 * Execute the full startup recovery pipeline.
 *
 * Scans the runs directory for tasks in recoverable states (active, paused,
 * waiting), applies recovery actions for each category, and returns the
 * recovered tasks grouped by their post-recovery status.
 *
 * Recovery actions by status:
 * - **Active**: Rebuild the subtask queue via {@link rebuildQueueForActiveTask}
 * - **Paused**: Check timeout deadlines via `checkTimeouts` (may transition
 *   to waiting if the resume deadline expired)
 * - **Waiting**: No action needed (returned as-is for operator intervention)
 *
 * Because `checkTimeouts` may mutate paused tasks to "waiting" status, the
 * returned grouping reflects post-recovery state, not pre-recovery state.
 *
 * @param runsDir - Base directory containing all task run directories
 * @returns Categorized recovery results grouped by post-recovery status
 */
export async function performRecovery(
  runsDir: string,
): Promise<RecoveryResult> {
  const tasks = await recoverTasks(runsDir);
  const preScan = categorizeByStatus(tasks);

  // Apply active task recovery (queue rebuild)
  for (const task of preScan.active) {
    await rebuildQueueForActiveTask(runsDir, task);
  }

  // Check paused task timeouts (may transition some to waiting)
  await checkTimeouts(runsDir, preScan.paused);

  // Build final result reflecting post-recovery status. Active and
  // originally-waiting tasks keep their category. Paused tasks are
  // re-evaluated since checkTimeouts may have transitioned some to waiting.
  return {
    active: preScan.active,
    paused: preScan.paused.filter((t) => t.status === "paused"),
    waiting: [
      ...preScan.waiting,
      ...preScan.paused.filter((t) => t.status === "waiting"),
    ],
  };
}
