import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendJournalEntry,
  readJournal,
  JOURNAL_ENTRY_TYPES,
} from "../../src/runtime/journal.js";
import type {
  JournalEntry,
  JournalEntryType,
} from "../../src/runtime/journal.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-journal-test-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

/** Build the expected journal file path for direct filesystem assertions. */
function journalPath(taskId: string): string {
  return path.join(runsDir, taskId, "journal.jsonl");
}

/**
 * Factory that produces a minimal valid entry for a given journal entry type.
 * Returns an object without the timestamp field (the implementation adds it).
 */
function createEntry(
  type: JournalEntryType,
  extra?: Record<string, unknown>,
): Omit<JournalEntry, "timestamp"> {
  const payloads: Record<JournalEntryType, Record<string, unknown>> = {
    task_created: { taskId: "task-001", recipeId: "new-implementation", trigger: "slash-command" },
    subtask_queued: { subtaskId: "task-001-0", kind: "orchestrator_eval", stageId: "planning" },
    subtask_started: { subtaskId: "task-001-0", stageId: "planning" },
    orchestrator_decision: {
      decision: {
        action: "run_stage_agent",
        target_stage: "coding",
        reason: "planning complete",
      },
    },
    decision_rejected: {
      decision: {
        action: "run_stage_agent",
        target_stage: "deploy",
        reason: "skip to deploy",
      },
      rejectionReason: "transition not allowed",
    },
    subtask_completed: { subtaskId: "task-001-0", stageId: "planning", outputSummary: "plan created" },
    subtask_failed: { subtaskId: "task-001-0", stageId: "coding", error: "agent timeout" },
    task_paused: { reason: "awaiting human approval", resumeTarget: "review" },
    task_resumed: { resumedFrom: "paused", capturedInput: "user approved" },
    task_waiting: { reason: "waiting for external service", deadline: "2026-04-07T00:00:00Z" },
    task_completed: { summary: "all stages finished successfully" },
    task_failed: { error: "max retries exceeded", lastStageId: "coding" },
    artifact_registered: { artifactId: "artifact-001", label: "planning_doc", stageId: "planning" },
    script_started: { scriptId: "knowledge.prime", taskId: "task-001", inputHash: "abc123" },
    script_completed: { scriptId: "knowledge.prime", summary: "knowledge context built", durationMs: 3200 },
    script_failed: { scriptId: "knowledge.prime", error: "script timed out after 30000ms", exitCode: 1 },
  };

  return { type, ...payloads[type], ...extra };
}

// -------------------------------------------------------------------
// Group 1: appendJournalEntry -- JSONL Format
// -------------------------------------------------------------------

describe("appendJournalEntry -- JSONL Format", () => {
  it("single append creates valid JSONL line", async () => {
    const taskId = "task-jsonl-single";
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));

    const raw = await readFile(journalPath(taskId), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(1);
    expect(raw.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("task_created");
  });

  it("multiple appends produce multi-line JSONL file", async () => {
    const taskId = "task-jsonl-multi";
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));
    appendJournalEntry(runsDir, taskId, createEntry("subtask_queued"));
    appendJournalEntry(runsDir, taskId, createEntry("subtask_started"));

    const raw = await readFile(journalPath(taskId), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(3);

    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["task_created", "subtask_queued", "subtask_started"]);
  });

  it("first append creates journal file and parent directory", async () => {
    const taskId = "task-first-create";
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));

    const raw = await readFile(journalPath(taskId), "utf-8");
    expect(raw.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 2: appendJournalEntry -- Entry Structure
// -------------------------------------------------------------------

describe("appendJournalEntry -- Entry Structure", () => {
  it("every entry includes timestamp as ISO-8601 string", async () => {
    const taskId = "task-timestamp";
    const before = Date.now();
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));
    const after = Date.now();

    const raw = await readFile(journalPath(taskId), "utf-8");
    const parsed = JSON.parse(raw.trim());

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const ts = new Date(parsed.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("every entry includes the type discriminant field", async () => {
    const taskId = "task-type-field";
    appendJournalEntry(runsDir, taskId, createEntry("subtask_queued"));

    const raw = await readFile(journalPath(taskId), "utf-8");
    const parsed = JSON.parse(raw.trim());

    expect(parsed.type).toBe("subtask_queued");
  });

  it("entry payload fields are preserved in written JSON", async () => {
    const taskId = "task-payload";
    const decision = {
      action: "run_stage_agent",
      target_stage: "coding",
      reason: "planning complete",
    };
    appendJournalEntry(
      runsDir,
      taskId,
      createEntry("orchestrator_decision", { decision }),
    );

    const raw = await readFile(journalPath(taskId), "utf-8");
    const parsed = JSON.parse(raw.trim());

    expect(parsed.decision).toEqual(decision);
  });
});

// -------------------------------------------------------------------
// Group 3: readJournal -- Deserialization
// -------------------------------------------------------------------

describe("readJournal -- Deserialization", () => {
  it("returns empty array for nonexistent journal file", () => {
    const result = readJournal(runsDir, "nonexistent-task");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns typed JournalEntry array for existing journal", () => {
    const taskId = "task-read-typed";
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));
    appendJournalEntry(runsDir, taskId, createEntry("subtask_queued"));
    appendJournalEntry(runsDir, taskId, createEntry("subtask_started"));

    const entries = readJournal(runsDir, taskId);

    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("task_created");
    expect(entries[0].timestamp).toBeDefined();
    expect(entries[1].type).toBe("subtask_queued");
    expect(entries[2].type).toBe("subtask_started");
  });

  it("readJournal roundtrip preserves all entry data", () => {
    const taskId = "task-roundtrip";
    const inputEntries = [
      createEntry("task_created"),
      createEntry("orchestrator_decision"),
      createEntry("subtask_completed"),
    ];

    for (const entry of inputEntries) {
      appendJournalEntry(runsDir, taskId, entry);
    }

    const entries = readJournal(runsDir, taskId);

    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("task_created");
    expect((entries[0] as Record<string, unknown>).taskId).toBe("task-001");
    expect((entries[0] as Record<string, unknown>).recipeId).toBe("new-implementation");

    expect(entries[1].type).toBe("orchestrator_decision");
    expect((entries[1] as Record<string, unknown>).decision).toEqual({
      action: "run_stage_agent",
      target_stage: "coding",
      reason: "planning complete",
    });

    expect(entries[2].type).toBe("subtask_completed");
    expect((entries[2] as Record<string, unknown>).outputSummary).toBe("plan created");
  });
});

// -------------------------------------------------------------------
// Group 4: All 17 Entry Types
// -------------------------------------------------------------------

describe("All 17 Entry Types", () => {
  const ALL_TYPES: JournalEntryType[] = [
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
    "script_started",
    "script_completed",
    "script_failed",
    "script_output_injected",
  ];

  it("JOURNAL_ENTRY_TYPES contains all 17 types", () => {
    expect(JOURNAL_ENTRY_TYPES).toHaveLength(17);
    for (const t of ALL_TYPES) {
      expect(JOURNAL_ENTRY_TYPES).toContain(t);
    }
  });

  it.each(ALL_TYPES)(
    "entry type '%s' serializes and deserializes correctly",
    (entryType) => {
      const taskId = `task-type-${entryType}`;
      const input = createEntry(entryType);

      appendJournalEntry(runsDir, taskId, input);
      const entries = readJournal(runsDir, taskId);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe(entryType);
      expect(entries[0].timestamp).toBeDefined();

      // Verify that all payload fields from the input are present in the output
      for (const [key, value] of Object.entries(input)) {
        if (key === "type") continue;
        expect((entries[0] as Record<string, unknown>)[key]).toEqual(value);
      }
    },
  );
});

// -------------------------------------------------------------------
// Group 5: Append-Only Invariant and Edge Cases
// -------------------------------------------------------------------

describe("Append-Only Invariant and Edge Cases", () => {
  it("existing entries are not modified by new appends", () => {
    const taskId = "task-append-only";
    appendJournalEntry(runsDir, taskId, createEntry("task_created"));

    const firstRead = readJournal(runsDir, taskId);
    expect(firstRead).toHaveLength(1);
    const firstEntry = { ...firstRead[0] };

    appendJournalEntry(runsDir, taskId, createEntry("subtask_queued"));

    const secondRead = readJournal(runsDir, taskId);
    expect(secondRead).toHaveLength(2);

    // The first entry must be identical after the second append
    expect(secondRead[0].type).toBe(firstEntry.type);
    expect(secondRead[0].timestamp).toBe(firstEntry.timestamp);
  });

  it("rapid sequential writes preserve order", () => {
    const taskId = "task-order";
    const types: JournalEntryType[] = [
      "task_created",
      "subtask_queued",
      "subtask_started",
      "orchestrator_decision",
      "subtask_completed",
      "subtask_queued",
      "subtask_started",
      "subtask_failed",
      "task_paused",
      "task_resumed",
    ];

    for (const t of types) {
      appendJournalEntry(runsDir, taskId, createEntry(t));
    }

    const entries = readJournal(runsDir, taskId);
    expect(entries).toHaveLength(10);

    for (let i = 0; i < types.length; i++) {
      expect(entries[i].type).toBe(types[i]);
    }
  });

  it("readJournal handles empty file gracefully", async () => {
    const taskId = "task-empty-file";
    const dir = path.join(runsDir, taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "journal.jsonl"), "", "utf-8");

    const result = readJournal(runsDir, taskId);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 6: Script Execution Entry Types
// -------------------------------------------------------------------

describe("Script Execution Entry Types", () => {
  it("JOURNAL_ENTRY_TYPES includes script_started", () => {
    expect(JOURNAL_ENTRY_TYPES).toContain("script_started");
  });

  it("JOURNAL_ENTRY_TYPES includes script_completed", () => {
    expect(JOURNAL_ENTRY_TYPES).toContain("script_completed");
  });

  it("JOURNAL_ENTRY_TYPES includes script_failed", () => {
    expect(JOURNAL_ENTRY_TYPES).toContain("script_failed");
  });

  it("JOURNAL_ENTRY_TYPES has 17 total entry types after script additions", () => {
    expect(JOURNAL_ENTRY_TYPES).toHaveLength(17);
  });
});
