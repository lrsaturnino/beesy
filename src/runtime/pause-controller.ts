/**
 * Pause/resume/timeout lifecycle controller for the recipe-driven runtime.
 *
 * Provides the external API for resuming paused tasks (applying human input,
 * enqueuing the resume_after_input subtask, journaling) and scanning for
 * expired resume deadlines (transitioning paused tasks to "waiting" status).
 *
 * Consumed by external adapters (Slack message handler triggers resumeTask),
 * the timeout scheduler (periodic checkTimeouts scan), and recovery (finds
 * paused/waiting tasks on startup). The worker loop processes the resulting
 * resume_after_input subtask internally.
 *
 * Serial per-task: resume signals are processed sequentially in the
 * single-threaded Node.js execution model. The idempotent guard (check
 * status before mutating) is sufficient to prevent double-resume.
 *
 * @module runtime/pause-controller
 */

import type { Task } from "../queue/types.js";
import { persistTask, enqueueSubtask } from "./task-state.js";
import { appendJournalEntry } from "./journal.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default timeout window in milliseconds for paused tasks awaiting resume.
 *
 * When a task enters "paused" status, the worker sets resumeDeadlineAt to
 * `Date.now() + DEFAULT_RESUME_TIMEOUT_MS`. If no resume signal arrives
 * before the deadline, a timeout scan transitions the task to "waiting".
 *
 * Value: 30 minutes (1,800,000 ms).
 */
export const DEFAULT_RESUME_TIMEOUT_MS = 1_800_000;

/** Maximum length for the human input summary stored in journal entries. */
const JOURNAL_INPUT_SUMMARY_LIMIT = 500;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a paused task has exceeded its resume deadline.
 *
 * Returns true only for tasks that are (a) in "paused" status, (b) have a
 * resumeDeadlineAt set, and (c) whose deadline has passed relative to the
 * provided reference time. All other tasks return false.
 *
 * @param task - The task to evaluate
 * @param now  - Reference time for the deadline comparison
 * @returns true if the task's resume deadline has expired
 */
function isResumeDeadlineExpired(task: Task, now: Date): boolean {
  return (
    task.status === "paused" &&
    task.resumeDeadlineAt !== undefined &&
    now > task.resumeDeadlineAt
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resume a paused task with human input.
 *
 * Validates that the task is currently in "paused" status (idempotent guard),
 * applies the human input to `capturedHumanContext`, transitions the task to
 * "active" status, enqueues a `resume_after_input` subtask so the worker loop
 * can process the resume, journals `task_resumed`, and persists the updated
 * task state.
 *
 * Returns true if the resume was applied, false if the task was not in
 * "paused" status (no-op for idempotent duplicate signals).
 *
 * @param runsDir    - Base directory containing all task run directories
 * @param task       - The task to resume (mutated in place)
 * @param humanInput - Human-provided input text to capture on the task
 * @returns true if the resume was applied, false if the task was not paused
 */
export async function resumeTask(
  runsDir: string,
  task: Task,
  humanInput: string,
): Promise<boolean> {
  // Idempotent guard: only resume tasks that are currently paused
  if (task.status !== "paused") {
    return false;
  }

  // Apply human input
  task.capturedHumanContext = humanInput;

  // Transition to active so the worker loop can process the resume subtask
  // and so duplicate resume signals are rejected by the guard above
  task.status = "active";

  // Enqueue resume_after_input subtask at the stage where the task was paused
  await enqueueSubtask(runsDir, task, {
    kind: "resume_after_input",
    stageId: task.currentStageId!,
  });

  // Journal the resume event before persistence (authoritative record)
  appendJournalEntry(runsDir, task.id, {
    type: "task_resumed",
    humanInput: humanInput.slice(0, JOURNAL_INPUT_SUMMARY_LIMIT),
  });

  // Persist updated task state
  await persistTask(runsDir, task);

  return true;
}

/**
 * Scan tasks for expired resume deadlines and transition them to "waiting".
 *
 * For each task in the provided array, checks whether the task is in "paused"
 * status with a resumeDeadlineAt that has passed. Expired tasks transition to
 * "waiting" status with waitingSince set, a task_waiting journal entry, and
 * persisted state. Tasks within their deadline or not in "paused" status are
 * left unchanged.
 *
 * Operates on pre-loaded Task objects (no filesystem reads for scanning),
 * so this function does not block the event loop except for the persistence
 * writes of tasks that actually transition.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param tasks   - Array of tasks to check for expired deadlines
 */
export async function checkTimeouts(
  runsDir: string,
  tasks: Task[],
): Promise<void> {
  const now = new Date();

  for (const task of tasks) {
    if (!isResumeDeadlineExpired(task, now)) {
      continue;
    }

    // Transition expired task to waiting
    task.status = "waiting";
    task.waitingSince = new Date();

    appendJournalEntry(runsDir, task.id, {
      type: "task_waiting",
      reason: "resume deadline expired",
      resumeDeadlineAt: task.resumeDeadlineAt!.toISOString(),
    });

    await persistTask(runsDir, task);
  }
}
