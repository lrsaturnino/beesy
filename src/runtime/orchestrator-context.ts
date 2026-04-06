/**
 * Orchestrator context builder for the recipe-driven runtime.
 *
 * Assembles the full prompt context for orchestrator evaluation subtasks by
 * extracting the current stage, allowed transitions, budget limits, retry
 * counters, latest stage output, previous input patch, and journal summary
 * from the task state and recipe configuration. The resulting context object
 * is consumed by the worker loop to render the orchestrator prompt in the
 * `# Role / # Task / # Output` format.
 *
 * This is a pure, synchronous, data-assembly function with no side effects
 * or I/O. It follows the fresh-object-return pattern established by
 * {@link buildStepContext} in executor/context-builder.ts.
 *
 * @module runtime/orchestrator-context
 */

import type { Task } from "../queue/types.js";
import type { RecipeConfig, StageDefinition } from "../recipes/types.js";

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

/**
 * Structured context consumed by the orchestrator prompt renderer.
 *
 * Contains everything the orchestrator agent needs to make its next decision:
 * current stage topology, budget tracking, latest execution output, previous
 * input modifications, and a summary of the run journal.
 */
export interface OrchestratorContext {
  /** Active stage identifier from the task state. */
  currentStageId: string;
  /** Full stage definition for the current stage from the recipe. */
  stageDefinition: StageDefinition;
  /** Stage IDs the orchestrator may transition to from the current stage. */
  allowedTransitions: readonly string[];
  /** Output from the most recently completed stage run, null on first eval. */
  latestStageOutput: string | null;
  /** Key-value input modifications from the previous orchestrator decision. */
  inputPatch: Record<string, unknown> | null;
  /** Per-stage retry counters keyed by stage identifier. */
  retryCounts: Record<string, number>;
  /** Running count of orchestrator decisions for this task. */
  totalActionCount: number;
  /** Maximum retry attempts allowed per individual stage. */
  maxStageRetries: number;
  /** Total action budget for the entire recipe run. */
  maxTotalActions: number;
  /** Concise summary of recent run journal events. */
  journalSummary: string;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Build the orchestrator evaluation context from task state and recipe config.
 *
 * Looks up the current stage definition in the recipe, extracts budget and
 * retry tracking from the task, and normalizes optional parameters to their
 * default values. Returns a fresh plain object with no shared references to
 * the input objects (retryCounts is shallow-copied).
 *
 * @param task              - The parent task providing stage ID, retry counts, and action count
 * @param recipe            - The recipe configuration providing stage definitions and budget limits
 * @param latestStageOutput - Output from the last completed stage run (null or undefined on first eval)
 * @param inputPatch        - Input modifications from the previous orchestrator decision (null or undefined when absent)
 * @param journalSummary    - Concise summary of recent run journal events
 * @returns A fully populated OrchestratorContext for prompt rendering
 * @throws Error if the task has no currentStageId set (programming error in caller)
 * @throws Error if the task's currentStageId does not match any stage in the recipe
 */
export function buildOrchestratorContext(
  task: Task,
  recipe: RecipeConfig,
  latestStageOutput: string | null | undefined,
  inputPatch: Record<string, unknown> | null | undefined,
  journalSummary: string,
): OrchestratorContext {
  const stageId = task.currentStageId;
  if (!stageId) {
    throw new Error(
      "Task is missing currentStageId; cannot build orchestrator context",
    );
  }

  const stageDefinition: StageDefinition | undefined = recipe.stages[stageId];
  if (!stageDefinition) {
    throw new Error(
      `Stage "${stageId}" not found in recipe "${recipe.id}" stages`,
    );
  }

  return {
    currentStageId: stageId,
    stageDefinition,
    allowedTransitions: stageDefinition.allowed_transitions,
    latestStageOutput: latestStageOutput ?? null,
    inputPatch: inputPatch ?? null,
    retryCounts: { ...(task.stageRetryCount ?? {}) },
    totalActionCount: task.totalActionCount ?? 0,
    maxStageRetries: recipe.orchestrator.max_stage_retries,
    maxTotalActions: recipe.orchestrator.max_total_actions,
    journalSummary,
  };
}
