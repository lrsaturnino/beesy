/**
 * Delivery state tracking and notification for the delivery pipeline.
 *
 * Provides pure query functions over journal entries to determine which
 * delivery steps have completed, failed, or remain pending for a given
 * task. Also provides notification message building and resilient sending.
 *
 * The journal is the authoritative source of delivery state. The
 * Task.deliveryStatus field is a convenience cache populated by
 * state_patch merging; this module reconstructs ground truth from
 * the append-only journal.
 *
 * Design notes:
 * - All query functions are pure (no side effects, no I/O).
 * - `sendDeliveryNotification` is the only effectful function; it
 *   catches all errors so notification failure never propagates.
 * - Step names are derived from the DELIVERY_STEPS const array,
 *   following the same pattern as JOURNAL_ENTRY_TYPES in journal.ts.
 *
 * @module delivery/delivery-state
 */

import type { JournalEntry } from "../runtime/journal.js";
import type { Task } from "../queue/types.js";
import type { ChannelRef } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical delivery pipeline steps in execution order. */
export const DELIVERY_STEPS = ["stage", "commit", "push", "pr"] as const;

/** A single delivery step name derived from {@link DELIVERY_STEPS}. */
export type DeliveryStepName = (typeof DELIVERY_STEPS)[number];

/** Possible statuses for an individual delivery step. */
export type DeliveryStepStatus = "completed" | "pending" | "failed";

/** Per-step delivery state for the four canonical pipeline steps. */
export type DeliveryState = Record<DeliveryStepName, DeliveryStepStatus>;

/**
 * Maps journal completion event types to their corresponding delivery step.
 *
 * Only completion events are mapped here; the `delivery_failed` event type
 * uses the `deliveryStep` field on the entry itself to identify the step.
 */
const EVENT_TYPE_TO_STEP: Record<string, DeliveryStepName> = {
  delivery_stage_completed: "stage",
  delivery_commit_completed: "commit",
  delivery_push_completed: "push",
  delivery_pr_completed: "pr",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether a string is a valid delivery step name.
 *
 * Uses the DELIVERY_STEPS const array as the source of truth, avoiding
 * manual string comparisons and keeping validation in sync with the
 * type definition.
 *
 * @param value - String to check
 * @returns True when the value is a member of {@link DELIVERY_STEPS}
 */
function isValidDeliveryStep(value: string): value is DeliveryStepName {
  return (DELIVERY_STEPS as readonly string[]).includes(value);
}

/**
 * Build a fresh DeliveryState with all steps set to "pending".
 *
 * Extracted to a helper so the default state shape is defined in one
 * place and can be reused if additional callsites need a baseline state.
 *
 * @returns DeliveryState with every step set to "pending"
 */
function createPendingState(): DeliveryState {
  return {
    stage: "pending",
    commit: "pending",
    push: "pending",
    pr: "pending",
  };
}

// ---------------------------------------------------------------------------
// Pure query functions
// ---------------------------------------------------------------------------

/**
 * Reconstruct delivery pipeline state from journal entries.
 *
 * Scans the entries array for delivery-related event types and builds
 * a per-step status map. Completion events map directly to their step
 * via {@link EVENT_TYPE_TO_STEP}. Failure events use the `deliveryStep`
 * field on the entry to identify the affected step.
 *
 * Uses last-write-wins semantics: if the same step appears in multiple
 * entries (e.g., a retry scenario), the last entry determines the status.
 * All steps default to "pending" when no matching entry is found.
 *
 * @param entries - Journal entries to scan (in append order)
 * @returns Per-step delivery state
 */
export function queryDeliveryState(entries: JournalEntry[]): DeliveryState {
  const state = createPendingState();

  for (const entry of entries) {
    // Handle completion events via the event-type-to-step mapping
    const step = EVENT_TYPE_TO_STEP[entry.type];
    if (step) {
      state[step] = "completed";
      continue;
    }

    // Handle failure events: require a valid deliveryStep identifier
    if (
      entry.type === "delivery_failed" &&
      typeof entry.deliveryStep === "string" &&
      isValidDeliveryStep(entry.deliveryStep)
    ) {
      state[entry.deliveryStep] = "failed";
    }
  }

  return state;
}

/**
 * Check whether all four delivery steps have completed successfully.
 *
 * @param state - Delivery state to evaluate
 * @returns True only when every step has status "completed"
 */
export function isDeliveryComplete(state: DeliveryState): boolean {
  return DELIVERY_STEPS.every((step) => state[step] === "completed");
}

/**
 * Return the names of all delivery steps with "failed" status.
 *
 * @param state - Delivery state to query
 * @returns Array of step names that have failed (may be empty)
 */
export function getFailedSteps(state: DeliveryState): DeliveryStepName[] {
  return DELIVERY_STEPS.filter((step) => state[step] === "failed");
}

/**
 * Return the names of all delivery steps with "pending" status.
 *
 * @param state - Delivery state to query
 * @returns Array of step names still pending (may be empty)
 */
export function getPendingSteps(state: DeliveryState): DeliveryStepName[] {
  return DELIVERY_STEPS.filter((step) => state[step] === "pending");
}

// ---------------------------------------------------------------------------
// Notification message builder
// ---------------------------------------------------------------------------

/** Fallback text used when a delivery metadata field is not available. */
const FALLBACK_TEXT = "N/A";

/**
 * Extract a string field from a journal entry, returning a fallback when
 * the field is absent or not a string.
 *
 * @param entry - Journal entry to extract from (may be undefined)
 * @param field - Property name to read
 * @returns The field value as a string, or {@link FALLBACK_TEXT}
 */
function extractStringField(
  entry: JournalEntry | undefined,
  field: string,
): string {
  const value = entry?.[field];
  return typeof value === "string" ? value : FALLBACK_TEXT;
}

/**
 * Extract an array field from a journal entry and return its length.
 *
 * @param entry - Journal entry to extract from (may be undefined)
 * @param field - Property name expected to hold an array
 * @returns Number of items in the array, or 0 when absent/non-array
 */
function extractArrayLength(
  entry: JournalEntry | undefined,
  field: string,
): number {
  const value = entry?.[field];
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Build a human-readable Slack notification message for a delivery result.
 *
 * Extracts the PR URL and branch name from the task, the staged file count
 * from the `delivery_stage_completed` journal entry, and the commit summary
 * from the `delivery_commit_completed` journal entry. Missing fields are
 * handled gracefully with fallback text.
 *
 * @param task    - Task containing delivery metadata (prUrl, branchName)
 * @param _state  - Delivery state (included for forward-compatible callsites
 *                  that may use it for conditional formatting in the future)
 * @param entries - Journal entries for extracting step-specific metadata
 * @returns Formatted notification message string
 */
export function buildNotificationMessage(
  task: Task,
  _state: DeliveryState,
  entries: JournalEntry[],
): string {
  const prUrl = task.prUrl ?? FALLBACK_TEXT;
  const branchName = task.branchName ?? FALLBACK_TEXT;

  const stageEntry = entries.find((e) => e.type === "delivery_stage_completed");
  const fileCount = extractArrayLength(stageEntry, "stagedFiles");

  const commitEntry = entries.find((e) => e.type === "delivery_commit_completed");
  const commitSummary = extractStringField(commitEntry, "commitMessage");

  return [
    `Delivery complete for branch \`${branchName}\``,
    "",
    `PR: ${prUrl}`,
    `Files changed: ${fileCount}`,
    `Commit: ${commitSummary}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Resilient notification sender
// ---------------------------------------------------------------------------

/**
 * Send a delivery notification via the provided reply function.
 *
 * Wraps the sendReply call in a try/catch to ensure notification failures
 * never propagate as exceptions. Delivery artifacts (branch, PR) are
 * already durable at this point; notification is best-effort.
 *
 * Both synchronous throws and rejected promises are caught. On failure,
 * the error is logged at warn level for operational visibility but is
 * never re-thrown, following the same error-handling philosophy as the
 * other delivery action modules (push-branch, upsert-draft-pr).
 *
 * @param sendReply - Function to send a message to a channel (injected dependency)
 * @param channel   - Target channel for the notification
 * @param message   - Notification message text
 * @returns True if the notification was sent successfully, false otherwise
 */
export async function sendDeliveryNotification(
  sendReply: (channel: ChannelRef, text: string) => Promise<void>,
  channel: ChannelRef,
  message: string,
): Promise<boolean> {
  try {
    await sendReply(channel, message);
    return true;
  } catch {
    // Notification failure is non-fatal; delivery artifacts are already durable
    return false;
  }
}
