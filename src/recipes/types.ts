/**
 * Recipe configuration types for the stage-graph workflow runtime.
 *
 * Defines the recipe schema that drives the orchestrator/worker execution
 * model: recipe metadata, orchestrator agent configuration, stage definitions
 * with declared inputs/outputs, and the structured decision contract returned
 * by the orchestrator agent.
 *
 * Consumed by the recipe loader (deserialization), decision validator (policy
 * enforcement), and deterministic worker (dispatch and execution).
 *
 * @module recipes/types
 */

// ---------------------------------------------------------------------------
// Orchestrator action constants
// ---------------------------------------------------------------------------

/**
 * Valid orchestrator decision action strings.
 *
 * Exported as a const array so downstream validators can perform runtime
 * membership checks without duplicating the literal values.
 */
export const ORCHESTRATOR_ACTIONS = [
  "run_stage_agent",
  "pause_for_input",
  "finish_run",
  "fail_run",
  "run_script",
] as const;

/** Orchestrator decision action union type derived from {@link ORCHESTRATOR_ACTIONS}. */
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the orchestrator agent that drives a recipe run.
 *
 * Fields intentionally mirror the snake_case recipe YAML schema so the loader
 * can deserialize without field renaming.
 *
 * @see AgentConfig in runners/types.ts for the aligned per-step agent config.
 */
export interface OrchestratorConfig {
  /** Filesystem path to the orchestrator role file. */
  role: string;
  /** CLI backend identifier (e.g., "cli-claude"). */
  backend: string;
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-20250514"). */
  model: string;
  /** Effort level for orchestrator evaluations (e.g., "high"). */
  effort: string;
  /** Maximum orchestrator evaluation time in milliseconds. */
  timeout_ms: number;
  /** Maximum retry attempts allowed per individual stage. */
  max_stage_retries: number;
  /** Total action budget for the entire recipe run. */
  max_total_actions: number;
}

// ---------------------------------------------------------------------------
// Stage-level types
// ---------------------------------------------------------------------------

/** A declared input binding for a recipe stage. */
export interface StageInput {
  /** Human-readable description of what this input provides. */
  description: string;
  /** Data binding expression resolved at runtime (e.g., "task.payload.description"). */
  source: string;
}

/** A declared output produced by a recipe stage. */
export interface StageOutput {
  /** Logical output name used as an artifact key (e.g., "planning_doc"). */
  label: string;
  /** Output format identifier (e.g., "md", "json"). */
  format: string;
  /**
   * Optional workspace-local file paths where the output is mirrored for
   * backward-compatible consumption (e.g., `[".bees/planning.md"]`).
   * The artifact registry remains the source of truth.
   */
  mirror_to?: string[];
}

/** Definition of a single stage in the recipe stage graph. */
export interface StageDefinition {
  /** Filesystem path to the stage agent role file. */
  role: string;
  /** Objective describing what the stage agent should accomplish. */
  objective: string;
  /** Declared stage inputs with data binding expressions. */
  inputs: readonly StageInput[];
  /** Declared stage outputs with format and optional mirror paths. */
  outputs: readonly StageOutput[];
  /** Stage IDs the orchestrator may transition to from this stage. */
  allowed_transitions: readonly string[];
  /** Script IDs the orchestrator may invoke while in this stage. */
  allowed_scripts: readonly string[];
}

// ---------------------------------------------------------------------------
// Orchestrator decision contract
// ---------------------------------------------------------------------------

/**
 * Structured decision returned by the orchestrator agent.
 *
 * The {@link action} field acts as a discriminant; downstream validators use
 * it to enforce transition policy and budget limits against the recipe.
 */
export interface OrchestratorDecision {
  /** Discriminated action type for this decision. */
  action: OrchestratorAction;
  /** Target stage for the action (e.g., stage to run or transition to). */
  target_stage?: string;
  /** Key-value modifications merged into the next stage's resolved input. */
  input_patch?: Record<string, unknown>;
  /** Key-value modifications merged into the persistent run state. */
  state_patch?: Record<string, unknown>;
  /** Human-readable justification for the decision. */
  reason?: string;
  /** Identifier of the script to execute when action is run_script. */
  script_id?: string;
}

// ---------------------------------------------------------------------------
// Top-level recipe configuration
// ---------------------------------------------------------------------------

/**
 * Top-level recipe configuration modeling the recipe YAML schema.
 *
 * Metadata fields (id, name, command, description) parallel
 * {@link GateMetadata} in gates/types.ts for consistency across both the
 * legacy gate system and the new recipe-driven runtime.
 */
export interface RecipeConfig {
  /** Unique recipe identifier (e.g., "new-implementation"). */
  id: string;
  /** Human-readable recipe name. */
  name: string;
  /** Slash command that triggers this recipe (e.g., "/new-implementation"). */
  command: string;
  /** Brief description of what this recipe does. */
  description: string;
  /** Orchestrator agent configuration for this recipe. */
  orchestrator: OrchestratorConfig;
  /** Canonical stage execution order defining the expected progression. */
  stage_order: readonly string[];
  /** Identifier of the first stage to enter when the recipe run begins. */
  start_stage: string;
  /** Stage definitions keyed by stage identifier. */
  stages: Record<string, StageDefinition>;
}
