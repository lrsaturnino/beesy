/**
 * Evidence validation utilities for supervised live runtime executions.
 *
 * Provides pre-run environment checks (env var presence, repo accessibility)
 * and post-run evidence validators (journal stage coverage, operator
 * intervention shape, delivery artifact completeness). Each validator
 * returns a typed result envelope so callers can inspect failures
 * without catching exceptions.
 *
 * Consumed by the live-run validation test suite and the operator
 * supervision workflow to confirm that all expected evidence artifacts
 * exist and are well-formed after a full recipe execution.
 *
 * @module runtime/live-run-evidence
 */

import { access } from "node:fs/promises";
import type { JournalEntry } from "./journal.js";
import type { Task } from "../queue/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Delivery steps tracked in the task deliveryStatus map.
 *
 * The four canonical delivery pipeline actions in execution order:
 * staging files, creating a conventional commit, pushing the branch,
 * and upserting the draft pull request. The commit_and_pr terminal
 * stage invokes one script per step.
 *
 * Exported as a const array so downstream consumers can perform
 * runtime membership checks without duplicating literal values.
 */
export const DELIVERY_STEPS = ["stage", "commit", "push", "pr"] as const;

/** Union type of valid delivery step identifiers. */
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of pre-run environment validation. */
export interface PreRunValidationResult {
  /** True when all prerequisites are satisfied. */
  valid: boolean;
  /** Collected validation errors (empty when valid is true). */
  errors: Array<{ field: string; reason: string }>;
}

/** Outcome of post-run journal evidence validation. */
export interface EvidenceValidationResult {
  /** True when all expected stages were traversed and a completion entry exists. */
  valid: boolean;
  /** Stage identifiers found in journal entries. */
  stagesCovered: string[];
  /** Expected stages not found in the journal. */
  missingStages: string[];
  /** Whether the journal contains a task_completed entry (successful run). */
  hasCompletionEntry: boolean;
}

/** Outcome of delivery evidence validation against task state. */
export interface DeliveryValidationResult {
  /** True when all delivery steps completed and required fields are present. */
  valid: boolean;
  /** Whether branchName is present on the task. */
  hasBranch: boolean;
  /** Whether prUrl is present on the task. */
  hasPrUrl: boolean;
  /** Whether prNumber is present on the task. */
  hasPrNumber: boolean;
  /** Whether every delivery step has "completed" status. */
  allStepsCompleted: boolean;
  /** Delivery steps that have a "failed" status. */
  failedSteps: DeliveryStep[];
}

// ---------------------------------------------------------------------------
// Pre-run environment validation
// ---------------------------------------------------------------------------

/**
 * Validate environment prerequisites before starting a live run.
 *
 * Checks that each required environment variable is present (non-empty)
 * in the provided env map, and that the target repository path is
 * accessible on the filesystem. Collects all errors so the caller
 * receives a complete diagnostic rather than failing on the first issue.
 *
 * @param options - Validation parameters
 * @param options.requiredEnvVars - Environment variable names to check
 * @param options.repoPath - Filesystem path to the target repository
 * @param options.env - Environment variable map to check against
 * @returns Validation result with collected errors
 */
export async function validatePreRunEnvironment(options: {
  requiredEnvVars: string[];
  repoPath: string;
  env: Record<string, string | undefined>;
}): Promise<PreRunValidationResult> {
  const { requiredEnvVars, repoPath, env } = options;
  const errors: Array<{ field: string; reason: string }> = [];

  // Check each required environment variable
  for (const varName of requiredEnvVars) {
    if (!env[varName] || env[varName]!.trim().length === 0) {
      errors.push({
        field: varName,
        reason: `Environment variable ${varName} is missing or empty`,
      });
    }
  }

  // Verify the target repository path is accessible
  try {
    await access(repoPath);
  } catch {
    errors.push({
      field: "repoPath",
      reason: `Repository path is not accessible: ${repoPath}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect all stage identifiers referenced in a journal entry sequence.
 *
 * Scans two entry fields that carry stage references: `target_stage`
 * (written by orchestrator decisions) and `stageId` (written by subtask
 * dispatch entries). Both are optional index-signature fields on
 * JournalEntry, so presence and type are checked defensively.
 *
 * @param journal - Array of journal entries to scan
 * @returns Set of unique stage identifiers found
 */
function collectReferencedStages(journal: JournalEntry[]): Set<string> {
  const stages = new Set<string>();

  for (const entry of journal) {
    if (typeof entry.target_stage === "string" && entry.target_stage.length > 0) {
      stages.add(entry.target_stage);
    }
    if (typeof entry.stageId === "string" && entry.stageId.length > 0) {
      stages.add(entry.stageId);
    }
  }

  return stages;
}

// ---------------------------------------------------------------------------
// Evidence structure validation
// ---------------------------------------------------------------------------

/**
 * Validate that a journal contains evidence of traversing all expected stages.
 *
 * Scans journal entries for stage references in orchestrator decisions
 * (target_stage field) and stage agent subtask dispatches (stageId field).
 * Determines which expected stages are covered and which are missing.
 * Also checks for a terminal task_completed entry indicating the run
 * reached a successful final state.
 *
 * @param journal - Array of journal entries to analyze
 * @param expectedStages - Stage identifiers that should appear in the journal
 * @returns Validation result with coverage details
 */
export function validateEvidenceStructure(
  journal: JournalEntry[],
  expectedStages: string[],
): EvidenceValidationResult {
  const stagesCovered = collectReferencedStages(journal);

  const stagesCoveredArray = [...stagesCovered];
  const missingStages = expectedStages.filter(
    (stage) => !stagesCovered.has(stage),
  );
  const hasCompletionEntry = journal.some(
    (entry) => entry.type === "task_completed",
  );

  return {
    valid: missingStages.length === 0 && hasCompletionEntry,
    stagesCovered: stagesCoveredArray,
    missingStages,
    hasCompletionEntry,
  };
}

// ---------------------------------------------------------------------------
// Operator intervention validation
// ---------------------------------------------------------------------------

/**
 * Extract and validate operator intervention entries from a journal.
 *
 * Filters journal entries for task_paused (operator checkpoint) and
 * task_resumed (operator response) events. The returned arrays preserve
 * chronological journal order so callers can correlate pause/resume pairs.
 *
 * @param journal - Array of journal entries to filter
 * @returns Pause and resume journal entries
 */
export function validateOperatorInterventions(journal: JournalEntry[]): {
  pauseEntries: JournalEntry[];
  resumeEntries: JournalEntry[];
} {
  const pauseEntries = journal.filter(
    (entry) => entry.type === "task_paused",
  );
  const resumeEntries = journal.filter(
    (entry) => entry.type === "task_resumed",
  );

  return { pauseEntries, resumeEntries };
}

// ---------------------------------------------------------------------------
// Delivery evidence validation
// ---------------------------------------------------------------------------

/**
 * Validate delivery evidence fields on a task state snapshot.
 *
 * Checks that the task carries the expected delivery metadata (branchName,
 * prUrl, prNumber) and that all delivery steps in the deliveryStatus map
 * have "completed" status. Steps with "failed" status are collected in
 * the failedSteps array.
 *
 * @param taskState - Partial task state to validate
 * @returns Validation result with per-field and per-step status
 */
export function validateDeliveryEvidence(
  taskState: Partial<Task>,
): DeliveryValidationResult {
  const hasBranch = typeof taskState.branchName === "string" && taskState.branchName.length > 0;
  const hasPrUrl = typeof taskState.prUrl === "string" && taskState.prUrl.length > 0;
  const hasPrNumber = typeof taskState.prNumber === "number" && taskState.prNumber > 0;

  const deliveryStatus = taskState.deliveryStatus ?? {};
  const failedSteps: DeliveryStep[] = [];
  let allStepsCompleted = true;

  for (const step of DELIVERY_STEPS) {
    if (deliveryStatus[step] === "failed") {
      failedSteps.push(step);
      allStepsCompleted = false;
    } else if (deliveryStatus[step] !== "completed") {
      allStepsCompleted = false;
    }
  }

  const valid = hasBranch && hasPrUrl && hasPrNumber && allStepsCompleted;

  return {
    valid,
    hasBranch,
    hasPrUrl,
    hasPrNumber,
    allStepsCompleted,
    failedSteps,
  };
}
