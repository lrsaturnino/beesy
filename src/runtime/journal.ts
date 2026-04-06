/**
 * Append-only run journal for recording runtime events as JSONL.
 *
 * Persists every meaningful lifecycle event to
 * `runtime/runs/<task-id>/journal.jsonl` as one JSON object per line.
 * Writes are synchronous to guarantee the entry is flushed before the
 * worker loop proceeds to the next subtask. Reads parse the full JSONL
 * file and return a typed array of journal entries.
 *
 * Consumed by the worker loop (appends at lifecycle transitions),
 * recovery (reads to reconstruct run context), orchestrator context
 * builder (summarises for the orchestrator prompt), and the
 * pause/resume controller (appends pause/resume/waiting entries).
 *
 * @module runtime/journal
 */

import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants and entry type definitions
// ---------------------------------------------------------------------------

/** Filename for the per-task journal JSONL log. */
const JOURNAL_FILENAME = "journal.jsonl";

/**
 * All valid journal entry type strings.
 *
 * Exported as a const array so downstream consumers can perform runtime
 * membership checks without duplicating the literal values.
 */
export const JOURNAL_ENTRY_TYPES = [
  "task_created",
  "subtask_queued",
  "subtask_started",
  "orchestrator_decision",
  "decision_rejected",
  "subtask_completed",
  "subtask_failed",
  "task_paused",
  "task_resumed",
  "task_waiting",
  "task_completed",
  "task_failed",
  "artifact_registered",
  // Script execution lifecycle
  "script_started",
  "script_completed",
  "script_failed",
  // Script-to-stage data injection
  "script_output_injected",
  // Delivery pipeline lifecycle
  "delivery_stage_completed",
  "delivery_commit_completed",
  "delivery_push_completed",
  "delivery_pr_completed",
  "delivery_failed",
] as const;

/** Journal entry type union derived from {@link JOURNAL_ENTRY_TYPES}. */
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

// ---------------------------------------------------------------------------
// Journal entry interface
// ---------------------------------------------------------------------------

/**
 * A single journal entry representing a runtime event.
 *
 * Every entry carries a timestamp and a type discriminant. Additional
 * payload fields vary by entry type and are stored as arbitrary
 * key-value pairs alongside the fixed fields.
 */
export interface JournalEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** Discriminant identifying the kind of runtime event. */
  type: JournalEntryType;
  /** Type-specific payload fields. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal path helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path to a task's run directory.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the target task
 */
function taskRunDir(runsDir: string, taskId: string): string {
  return path.join(runsDir, taskId);
}

/**
 * Absolute path to a task's journal file.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the target task
 */
function journalFilePath(runsDir: string, taskId: string): string {
  return path.join(taskRunDir(runsDir, taskId), JOURNAL_FILENAME);
}

// ---------------------------------------------------------------------------
// Internal JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw JSONL content into an array of journal entries.
 *
 * Splits the input on newlines, filters empty lines (trailing newline
 * is standard in JSONL), and parses each remaining line as independent
 * JSON. Malformed lines -- such as those produced by a partial write
 * during a process crash -- are silently skipped so that all valid
 * entries remain recoverable.
 *
 * @param raw - Raw JSONL file content
 * @returns Parsed journal entries in file order
 */
function parseJournalLines(raw: string): JournalEntry[] {
  const lines = raw.split("\n").filter((line) => line.length > 0);

  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // Skip malformed lines from partial writes on crash
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single journal entry to the task's JSONL journal file.
 *
 * Creates the task directory and journal file on first write. The
 * timestamp is auto-populated with the current UTC time. Writes are
 * synchronous to guarantee the entry is durable before the caller
 * proceeds.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the task this entry belongs to
 * @param entry   - Entry data without the timestamp (added automatically)
 */
export function appendJournalEntry(
  runsDir: string,
  taskId: string,
  entry: Omit<JournalEntry, "timestamp">,
): void {
  const dir = taskRunDir(runsDir, taskId);
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const fullEntry = { timestamp, ...entry };
  const line = JSON.stringify(fullEntry) + "\n";

  appendFileSync(journalFilePath(runsDir, taskId), line, "utf-8");
}

/**
 * Read all journal entries for a task.
 *
 * Returns the entries in chronological (append) order. Returns an empty
 * array when the journal file does not exist or is empty. Malformed
 * lines are silently skipped to tolerate partial writes on crash.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the task whose journal to read
 * @returns Array of journal entries in append order
 */
export function readJournal(runsDir: string, taskId: string): JournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(journalFilePath(runsDir, taskId), "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  return parseJournalLines(raw);
}
