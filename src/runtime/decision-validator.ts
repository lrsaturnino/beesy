/**
 * Orchestrator decision validator for recipe policy enforcement.
 *
 * Validates every orchestrator decision against the recipe configuration
 * before any side effect occurs. Enforces eight rules in order:
 *
 *   1. run_stage_agent requires a non-empty target_stage
 *   2. target_stage must be in the current stage's allowed_transitions
 *   3. Per-stage retry count must be below max_stage_retries
 *   4. Total action count must be below max_total_actions
 *   5. finish_run requires all current stage outputs to be produced
 *   6. run_script requires a non-empty script_id
 *   7. run_script script_id must exist in the registry and stage allowlist
 *   8. run_script required environment variables must be present
 *
 * Returns a discriminated union: valid decisions pass through unchanged,
 * invalid decisions produce a descriptive reason string containing all
 * violations. The validator collects every violation before returning
 * and never short-circuits on the first failure.
 *
 * Consumed by the worker loop (pre-execution gate) and the journal
 * (decision_rejected entries use the reason string directly).
 *
 * @module runtime/decision-validator
 */

import type {
  OrchestratorDecision,
  RecipeConfig,
  StageDefinition,
} from "../recipes/types.js";
import type { ScriptManifest } from "../scripts/types.js";
import { resolveScript, validateEnvRequirements } from "../scripts/registry.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Discriminated result of decision validation.
 *
 * When valid, the original decision object is returned by reference so the
 * caller can proceed without re-fetching. When invalid, the reason string
 * contains all collected violations joined by semicolons.
 */
export type ValidationResult =
  | { valid: true; decision: OrchestratorDecision }
  | { valid: false; reason: string };

// ---------------------------------------------------------------------------
// Per-rule validation helpers
// ---------------------------------------------------------------------------

/**
 * Check that a run_stage_agent decision includes a non-empty target_stage.
 * Other action types are not subject to this rule.
 */
function checkTargetStagePresent(decision: OrchestratorDecision): string | null {
  if (decision.action !== "run_stage_agent") return null;
  if (decision.target_stage) return null;

  return "run_stage_agent requires a target_stage but none was provided";
}

/**
 * Check that the target_stage is in the current stage's allowed_transitions.
 * Only applies to run_stage_agent decisions that have a target_stage.
 */
function checkTransitionLegality(
  decision: OrchestratorDecision,
  currentStageId: string,
  allowedTransitions: readonly string[],
): string | null {
  if (decision.action !== "run_stage_agent" || !decision.target_stage) {
    return null;
  }

  if (allowedTransitions.includes(decision.target_stage)) return null;

  return (
    `Transition from '${currentStageId}' to '${decision.target_stage}' ` +
    `is not allowed; allowed transitions: ${allowedTransitions.join(", ")}`
  );
}

/**
 * Check that the target stage's retry count is below the per-stage limit.
 * Only applies to run_stage_agent decisions that have a target_stage.
 */
function checkRetryBudget(
  decision: OrchestratorDecision,
  retryCounts: Record<string, number>,
  maxStageRetries: number,
): string | null {
  if (decision.action !== "run_stage_agent" || !decision.target_stage) {
    return null;
  }

  const retryCount = retryCounts[decision.target_stage] ?? 0;
  if (retryCount < maxStageRetries) return null;

  return (
    `Stage '${decision.target_stage}' retry count (${retryCount}) ` +
    `exceeds max_stage_retries (${maxStageRetries})`
  );
}

/**
 * Check that the total action count is below the run-wide budget.
 * Applies to all decision action types.
 */
function checkTotalActionBudget(
  totalActionCount: number,
  maxTotalActions: number,
): string | null {
  if (totalActionCount < maxTotalActions) return null;

  return (
    `Total action count (${totalActionCount}) ` +
    `exceeds max_total_actions (${maxTotalActions})`
  );
}

/**
 * Check that all required outputs have been produced before finishing a run.
 * Only applies to finish_run decisions when the current stage has declared
 * outputs. Stages with an empty outputs array pass unconditionally.
 */
function checkFinishRunOutputs(
  decision: OrchestratorDecision,
  currentStage: StageDefinition | undefined,
  completedOutputLabels: ReadonlySet<string>,
): string | null {
  if (decision.action !== "finish_run" || !currentStage) return null;

  const missingLabels = currentStage.outputs
    .map((output) => output.label)
    .filter((label) => !completedOutputLabels.has(label));

  if (missingLabels.length === 0) return null;

  return `Cannot finish_run: missing required outputs: ${missingLabels.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Script validation helpers
// ---------------------------------------------------------------------------

/**
 * Check that a run_script decision includes a non-empty script_id.
 * Other action types are not subject to this rule.
 */
function checkScriptIdPresent(decision: OrchestratorDecision): string | null {
  if (decision.action !== "run_script") return null;
  if (decision.script_id) return null;

  return "run_script requires a script_id but none was provided";
}

/**
 * Check that the script_id exists in the registry and is in the current
 * stage's allowed_scripts list. Skips validation when no registry is
 * provided (backward compatibility) or when the decision lacks a script_id
 * (caught by checkScriptIdPresent).
 */
function checkScriptAllowlist(
  decision: OrchestratorDecision,
  registry: Map<string, ScriptManifest> | undefined,
  currentStage: StageDefinition | undefined,
): string | null {
  if (decision.action !== "run_script" || !decision.script_id || !registry) {
    return null;
  }

  const manifest = resolveScript(registry, decision.script_id);
  if (!manifest) {
    return `Script '${decision.script_id}' not found in registry`;
  }

  const allowedScripts = currentStage?.allowed_scripts ?? [];
  if (!allowedScripts.includes(decision.script_id)) {
    return (
      `Script '${decision.script_id}' is not in allowed_scripts ` +
      `for stage; allowed: ${allowedScripts.length > 0 ? allowedScripts.join(", ") : "(none)"}`
    );
  }

  return null;
}

/**
 * Check that all required environment variables for the script are present.
 * Delegates to the registry's validateEnvRequirements function. Skips when
 * no registry is provided or when the decision lacks a script_id.
 */
function checkScriptEnvRequirements(
  decision: OrchestratorDecision,
  registry: Map<string, ScriptManifest> | undefined,
): string | null {
  if (decision.action !== "run_script" || !decision.script_id || !registry) {
    return null;
  }

  const envResult = validateEnvRequirements(registry, decision.script_id);
  if (!envResult || envResult.valid) return null;

  return (
    `Script '${decision.script_id}' requires missing environment variables: ` +
    envResult.missing.join(", ")
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an orchestrator decision against recipe policy.
 *
 * Runs eight rule checks in order, collecting all violations before
 * returning. Each rule is an independent predicate that returns either
 * a violation description or null when the decision satisfies the rule:
 *
 * 1. run_stage_agent requires a non-empty target_stage
 * 2. target_stage must be in the current stage's allowed_transitions
 * 3. Per-stage retry count must be below max_stage_retries
 * 4. Total action count must be below max_total_actions
 * 5. finish_run requires all current stage outputs to be produced
 * 6. run_script requires a non-empty script_id
 * 7. run_script script_id must exist in the registry and stage allowlist
 * 8. run_script required environment variables must be present
 *
 * Rules 6-8 only fire when a registry is provided. When the registry
 * parameter is omitted, script validation is skipped for backward
 * compatibility with callers that do not have access to the registry.
 *
 * @param decision              - The orchestrator decision to validate
 * @param recipe                - Recipe configuration providing stage definitions and budget limits
 * @param currentStageId        - Active stage identifier
 * @param retryCounts           - Per-stage retry counters keyed by stage identifier
 * @param totalActionCount      - Running count of orchestrator decisions for this task
 * @param completedOutputLabels - Output labels already produced (for finish_run validation)
 * @param registry              - Script registry for run_script validation (optional for backward compatibility)
 * @returns Valid result with the original decision, or invalid result with all violations
 */
export function validateDecision(
  decision: OrchestratorDecision,
  recipe: RecipeConfig,
  currentStageId: string,
  retryCounts: Record<string, number>,
  totalActionCount: number,
  completedOutputLabels?: ReadonlySet<string>,
  registry?: Map<string, ScriptManifest>,
): ValidationResult {
  const currentStage = recipe.stages[currentStageId];
  const allowedTransitions = currentStage?.allowed_transitions ?? [];
  const completed = completedOutputLabels ?? new Set<string>();

  const violations = [
    checkTargetStagePresent(decision),
    checkTransitionLegality(decision, currentStageId, allowedTransitions),
    checkRetryBudget(decision, retryCounts, recipe.orchestrator.max_stage_retries),
    checkTotalActionBudget(totalActionCount, recipe.orchestrator.max_total_actions),
    checkFinishRunOutputs(decision, currentStage, completed),
    checkScriptIdPresent(decision),
    checkScriptAllowlist(decision, registry, currentStage),
    checkScriptEnvRequirements(decision, registry),
  ].filter((v): v is string => v !== null);

  if (violations.length === 0) {
    return { valid: true, decision };
  }

  return { valid: false, reason: violations.join("; ") };
}
