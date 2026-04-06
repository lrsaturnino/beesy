import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Logger mock (vi.hoisted so the factory can reference mocks)
// ---------------------------------------------------------------

const { mockWarn, mockInfo, mockError, mockDebug } = vi.hoisted(() => {
  return {
    mockWarn: vi.fn(),
    mockInfo: vi.fn(),
    mockError: vi.fn(),
    mockDebug: vi.fn(),
  };
});

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  }),
  logger: {
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  },
}));

// ---------------------------------------------------------------
// Module under test (will fail until delivery-state.ts is created)
// ---------------------------------------------------------------

import {
  queryDeliveryState,
  isDeliveryComplete,
  getFailedSteps,
  getPendingSteps,
  buildNotificationMessage,
  sendDeliveryNotification,
} from "../../src/delivery/delivery-state.js";

// ---------------------------------------------------------------
// Modules used for integration tests
// ---------------------------------------------------------------

import {
  appendJournalEntry,
  readJournal,
} from "../../src/runtime/journal.js";

import { persistTask, loadTask } from "../../src/runtime/task-state.js";
import type { Task } from "../../src/queue/types.js";
import type { ChannelRef } from "../../src/adapters/types.js";
import type { JournalEntry } from "../../src/runtime/journal.js";

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

/** Temp directories created during tests, cleaned up in afterEach. */
const tempDirs: string[] = [];

/** Create a temp directory for journal/task-state operations. */
async function createTempRunsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bees-delivery-state-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

/** Build a minimal Task object with delivery-relevant fields. */
function buildTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "test-task-001",
    gate: "new-implementation",
    status: "active",
    priority: "normal",
    position: 0,
    payload: {},
    requestedBy: "U001",
    sourceChannel: { platform: "slack", channelId: "C001", threadTs: "123.456" },
    createdAt: new Date(),
    cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    branchName: "bees/test-task-001-feature",
    prUrl: "https://github.com/org/repo/pull/42",
    prNumber: 42,
    ...overrides,
  };
}

/** Build a journal entry for a delivery step completion. */
function deliveryEntry(
  type: JournalEntry["type"],
  extra: Record<string, unknown> = {},
): Omit<JournalEntry, "timestamp"> {
  return { type, scriptId: `delivery.${type}`, ...extra };
}

// ===================================================================
// Unit Tests: queryDeliveryState
// ===================================================================

describe("queryDeliveryState", () => {
  it("returns all-completed when all four delivery events present", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit", stagedFiles: ["a.ts"], excludedFiles: [] },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_commit_completed", scriptId: "delivery.commit_with_trailers", commitSha: "abc1234", commitMessage: "feat: add feature" },
      { timestamp: "2026-01-01T00:02:00Z", type: "delivery_push_completed", scriptId: "delivery.push_branch", remoteBranch: "origin/main", branchName: "feature/test" },
      { timestamp: "2026-01-01T00:03:00Z", type: "delivery_pr_completed", scriptId: "delivery.upsert_draft_pr", prUrl: "https://github.com/org/repo/pull/1", prNumber: 1, action: "created" },
    ];

    const state = queryDeliveryState(entries);

    expect(state.stage).toBe("completed");
    expect(state.commit).toBe("completed");
    expect(state.push).toBe("completed");
    expect(state.pr).toBe("completed");
    expect(isDeliveryComplete(state)).toBe(true);
  });

  it("returns partial state when push completed but PR missing", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit" },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_commit_completed", scriptId: "delivery.commit_with_trailers" },
      { timestamp: "2026-01-01T00:02:00Z", type: "delivery_push_completed", scriptId: "delivery.push_branch" },
    ];

    const state = queryDeliveryState(entries);

    expect(state.push).toBe("completed");
    expect(state.pr).toBe("pending");
    expect(isDeliveryComplete(state)).toBe(false);
  });

  it("returns failed step when delivery_failed entry present with deliveryStep", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit" },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_commit_completed", scriptId: "delivery.commit_with_trailers" },
      { timestamp: "2026-01-01T00:02:00Z", type: "delivery_failed", scriptId: "delivery.push_branch", error: "push failed", deliveryStep: "push" },
    ];

    const state = queryDeliveryState(entries);

    expect(state.stage).toBe("completed");
    expect(state.commit).toBe("completed");
    expect(state.push).toBe("failed");
    expect(getFailedSteps(state)).toContain("push");
  });

  it("returns all-pending when no delivery events present", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "task_created", taskId: "test-001" },
      { timestamp: "2026-01-01T00:01:00Z", type: "subtask_queued", subtaskId: "sub-001" },
    ];

    const state = queryDeliveryState(entries);

    expect(state.stage).toBe("pending");
    expect(state.commit).toBe("pending");
    expect(state.push).toBe("pending");
    expect(state.pr).toBe("pending");
    expect(isDeliveryComplete(state)).toBe(false);
  });

  it("handles empty journal entries array", () => {
    const state = queryDeliveryState([]);

    expect(state.stage).toBe("pending");
    expect(state.commit).toBe("pending");
    expect(state.push).toBe("pending");
    expect(state.pr).toBe("pending");
    expect(isDeliveryComplete(state)).toBe(false);
  });
});

describe("getPendingSteps", () => {
  it("returns only steps not yet completed or failed", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit" },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_commit_completed", scriptId: "delivery.commit_with_trailers" },
    ];

    const state = queryDeliveryState(entries);
    const pending = getPendingSteps(state);

    expect(pending).toContain("push");
    expect(pending).toContain("pr");
    expect(pending).not.toContain("stage");
    expect(pending).not.toContain("commit");
    expect(pending).toHaveLength(2);
  });
});

describe("getFailedSteps", () => {
  it("returns only steps with failed status", () => {
    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit" },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_failed", scriptId: "delivery.commit_with_trailers", deliveryStep: "commit", error: "commit failed" },
    ];

    const state = queryDeliveryState(entries);
    const failed = getFailedSteps(state);

    expect(failed).toEqual(["commit"]);
    expect(failed).not.toContain("stage");
  });
});

// ===================================================================
// Unit Tests: Notification Message Builder
// ===================================================================

describe("buildNotificationMessage", () => {
  it("includes PR URL, branch name, file count, and commit summary", () => {
    const task = buildTestTask({
      prUrl: "https://github.com/org/repo/pull/42",
      branchName: "bees/task-001-feature",
    });

    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_stage_completed", scriptId: "delivery.stage_explicit", stagedFiles: ["a.ts", "b.ts", "c.ts"] },
      { timestamp: "2026-01-01T00:01:00Z", type: "delivery_commit_completed", scriptId: "delivery.commit_with_trailers", commitSha: "abc1234", commitMessage: "feat: add feature" },
      { timestamp: "2026-01-01T00:02:00Z", type: "delivery_push_completed", scriptId: "delivery.push_branch" },
      { timestamp: "2026-01-01T00:03:00Z", type: "delivery_pr_completed", scriptId: "delivery.upsert_draft_pr" },
    ];

    const state = queryDeliveryState(entries);
    const message = buildNotificationMessage(task, state, entries);

    expect(message).toContain("https://github.com/org/repo/pull/42");
    expect(message).toContain("bees/task-001-feature");
    expect(message).toContain("3");
    expect(message).toContain("feat: add feature");
  });

  it("handles missing optional fields gracefully", () => {
    const task = buildTestTask({
      prUrl: "https://github.com/org/repo/pull/42",
      branchName: undefined,
    });

    const entries: JournalEntry[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "delivery_pr_completed", scriptId: "delivery.upsert_draft_pr" },
    ];

    const state = queryDeliveryState(entries);

    expect(() => buildNotificationMessage(task, state, entries)).not.toThrow();
    const message = buildNotificationMessage(task, state, entries);
    expect(message).toContain("https://github.com/org/repo/pull/42");
  });
});

// ===================================================================
// Unit Tests: Notification Failure Resilience
// ===================================================================

describe("sendDeliveryNotification", () => {
  it("does not throw when sendReply rejects", async () => {
    const mockSendReply = vi.fn().mockRejectedValue(new Error("Slack API error"));
    const channel: ChannelRef = { platform: "slack", channelId: "C001", threadTs: "123.456" };

    const result = await sendDeliveryNotification(mockSendReply, channel, "Test message");

    expect(result).toBe(false);
    expect(mockSendReply).toHaveBeenCalledOnce();
  });

  it("does not throw when sendReply throws synchronously", async () => {
    const mockSendReply = vi.fn().mockImplementation(() => {
      throw new Error("Synchronous Slack failure");
    });
    const channel: ChannelRef = { platform: "slack", channelId: "C001" };

    const result = await sendDeliveryNotification(mockSendReply, channel, "Test message");

    expect(result).toBe(false);
    expect(mockSendReply).toHaveBeenCalledOnce();
  });
});

// ===================================================================
// Integration Tests: Partial Failure Scenarios
// ===================================================================

describe("Partial Failure Integration", () => {
  it("push succeeds + PR fails: journal shows partial delivery state", async () => {
    const runsDir = await createTempRunsDir();
    const taskId = "test-task-partial-001";

    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_stage_completed", { stagedFiles: ["a.ts"] }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_commit_completed", { commitSha: "abc1234" }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_push_completed", { remoteBranch: "origin/feature" }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_failed", { deliveryStep: "pr", error: "gh cli failed" }));

    const entries = readJournal(runsDir, taskId);
    const state = queryDeliveryState(entries);

    expect(state.stage).toBe("completed");
    expect(state.commit).toBe("completed");
    expect(state.push).toBe("completed");
    expect(state.pr).toBe("failed");
    expect(getFailedSteps(state)).toEqual(["pr"]);
    expect(getPendingSteps(state)).toEqual([]);
  });

  it("PR succeeds + notification fails: prUrl remains in task state", async () => {
    const runsDir = await createTempRunsDir();
    const task = buildTestTask({
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      deliveryStatus: { stage: "completed", commit: "completed", push: "completed", pr: "completed" },
    });

    await persistTask(runsDir, task);

    const mockSendReply = vi.fn().mockRejectedValue(new Error("Slack down"));
    const channel: ChannelRef = { platform: "slack", channelId: "C001", threadTs: "123.456" };
    const notificationResult = await sendDeliveryNotification(mockSendReply, channel, "Delivery done");

    expect(notificationResult).toBe(false);

    const loadedTask = await loadTask(runsDir, task.id);
    expect(loadedTask).not.toBeNull();
    expect(loadedTask!.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(loadedTask!.deliveryStatus?.pr).toBe("completed");
  });
});

// ===================================================================
// Integration Tests: Full Delivery Pipeline
// ===================================================================

describe("Full Delivery Pipeline Integration", () => {
  it("all journal entries present after full delivery flow", async () => {
    const runsDir = await createTempRunsDir();
    const taskId = "test-task-full-001";

    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_stage_completed", {
      stagedFiles: ["src/feature.ts", "tests/feature.test.ts"],
      excludedFiles: [],
    }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_commit_completed", {
      commitSha: "deadbeef1234567890",
      commitMessage: "feat(delivery): add feature implementation",
    }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_push_completed", {
      remoteBranch: "origin/bees/test-task-full-001-feature",
      branchName: "bees/test-task-full-001-feature",
    }));
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_pr_completed", {
      prUrl: "https://github.com/org/repo/pull/99",
      prNumber: 99,
      action: "created",
    }));

    const entries = readJournal(runsDir, taskId);
    const deliveryEntries = entries.filter((e) => e.type.startsWith("delivery_"));

    expect(deliveryEntries).toHaveLength(4);

    const state = queryDeliveryState(entries);
    expect(isDeliveryComplete(state)).toBe(true);
  });
});

// ===================================================================
// End-to-End Smoke Test
// ===================================================================

describe("End-to-End Smoke Test", () => {
  it("full delivery pipeline with journal trace and notification content", async () => {
    const runsDir = await createTempRunsDir();
    const taskId = "test-task-e2e-001";

    // Simulate stage step
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_stage_completed", {
      stagedFiles: ["src/handler.ts", "src/utils.ts", "tests/handler.test.ts"],
      excludedFiles: [{ path: ".env", reason: "excluded by policy" }],
    }));

    // Simulate commit step
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_commit_completed", {
      commitSha: "a1b2c3d4e5f6",
      commitMessage: "feat(handler): implement request handler",
    }));

    // Simulate push step
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_push_completed", {
      remoteBranch: "origin/bees/test-task-e2e-001-handler",
      branchName: "bees/test-task-e2e-001-handler",
    }));

    // Simulate PR step
    appendJournalEntry(runsDir, taskId, deliveryEntry("delivery_pr_completed", {
      prUrl: "https://github.com/org/repo/pull/77",
      prNumber: 77,
      action: "created",
    }));

    // Read back and verify journal trace
    const entries = readJournal(runsDir, taskId);
    expect(entries).toHaveLength(4);

    // Verify chronological order via timestamps
    for (let i = 1; i < entries.length; i++) {
      expect(new Date(entries[i].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(entries[i - 1].timestamp).getTime());
    }

    // Verify each entry has expected metadata
    const stageEntry = entries.find((e) => e.type === "delivery_stage_completed");
    expect(stageEntry?.scriptId).toBe("delivery.delivery_stage_completed");
    expect(stageEntry?.stagedFiles).toHaveLength(3);

    const commitEntry = entries.find((e) => e.type === "delivery_commit_completed");
    expect(commitEntry?.commitSha).toBe("a1b2c3d4e5f6");

    // Verify delivery state is complete
    const state = queryDeliveryState(entries);
    expect(isDeliveryComplete(state)).toBe(true);
    expect(getFailedSteps(state)).toEqual([]);
    expect(getPendingSteps(state)).toEqual([]);

    // Build notification and verify content
    const task = buildTestTask({
      prUrl: "https://github.com/org/repo/pull/77",
      branchName: "bees/test-task-e2e-001-handler",
    });
    const message = buildNotificationMessage(task, state, entries);

    expect(message).toContain("https://github.com/org/repo/pull/77");
    expect(message).toContain("bees/test-task-e2e-001-handler");
    expect(message).toContain("3");
    expect(message).toContain("feat(handler): implement request handler");
  });
});
