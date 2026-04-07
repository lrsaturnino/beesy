/**
 * Script manifest types for the registry system.
 *
 * Defines the metadata schema that drives script discovery, validation,
 * and execution: runtime identifiers, side-effect levels, rerun policies,
 * the full script manifest, an orchestrator-facing catalog summary, and
 * the structured envelope returned on script stdout.
 *
 * Consumed by the script registry (loading and catalog generation),
 * decision validator (policy enforcement), deterministic worker (dispatch
 * and execution), and orchestrator context injection.
 *
 * @module scripts/types
 */

// ---------------------------------------------------------------------------
// Script runtime constants
// ---------------------------------------------------------------------------

/**
 * Valid script execution runtime identifiers.
 *
 * Exported as a const array so downstream validators can perform runtime
 * membership checks without duplicating the literal values.
 */
export const SCRIPT_RUNTIMES = ["python", "node", "shell", "internal"] as const;

/** Script execution runtime union type derived from {@link SCRIPT_RUNTIMES}. */
export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

// ---------------------------------------------------------------------------
// Side-effect level constants
// ---------------------------------------------------------------------------

/**
 * Valid side-effect level identifiers describing a script's mutation scope.
 *
 * Exported as a const array so downstream validators can perform runtime
 * membership checks without duplicating the literal values.
 */
export const SIDE_EFFECT_LEVELS = ["read-only", "workspace-write", "external-write"] as const;

/** Side-effect level union type derived from {@link SIDE_EFFECT_LEVELS}. */
export type SideEffectLevel = (typeof SIDE_EFFECT_LEVELS)[number];

// ---------------------------------------------------------------------------
// Rerun policy constants
// ---------------------------------------------------------------------------

/**
 * Valid rerun policy identifiers declaring how a script handles re-execution.
 *
 * Exported as a const array so downstream validators can perform runtime
 * membership checks without duplicating the literal values.
 */
export const RERUN_POLICIES = ["restart", "continue", "refuse"] as const;

/** Rerun policy union type derived from {@link RERUN_POLICIES}. */
export type RerunPolicy = (typeof RERUN_POLICIES)[number];

// ---------------------------------------------------------------------------
// Script manifest interface
// ---------------------------------------------------------------------------

/**
 * Full metadata manifest for a registered script.
 *
 * Fields intentionally use snake_case to mirror the YAML manifest schema so
 * the registry loader can deserialize without field renaming.
 */
export interface ScriptManifest {
  /** Stable unique identifier for the script (e.g., "repo.search"). */
  script_id: string;
  /** Human-readable description of what the script does. */
  description: string;
  /** Execution runtime used to invoke the script. */
  runtime: ScriptRuntime;
  /** Filesystem path to the script file relative to the workspace root. */
  path: string;
  /** Maximum execution time in milliseconds before the worker kills the process. */
  timeout_ms: number;
  /** Whether the worker may retry this script on transient failure. */
  retryable: boolean;
  /** Declared mutation scope for safety and policy enforcement. */
  side_effects: SideEffectLevel;
  /** Environment variables that must be present before execution. */
  required_env: readonly string[];
  /** Optional JSON Schema describing the expected input payload. */
  input_schema?: Record<string, unknown>;
  /** Optional JSON Schema describing the expected output shape. */
  output_schema?: Record<string, unknown>;
  /** Optional free-text hints injected into orchestrator context. */
  orchestrator_notes?: string;
  /** Declared re-execution behavior when the script is invoked again. */
  rerun_policy: RerunPolicy;
}

// ---------------------------------------------------------------------------
// Script catalog entry type
// ---------------------------------------------------------------------------

/**
 * Orchestrator-visible summary of a registered script.
 *
 * Contains only the fields the orchestrator needs to make informed dispatch
 * decisions. The full {@link ScriptManifest} is used by the worker at
 * execution time.
 *
 * @see ScriptManifest for the complete manifest consumed at execution time.
 */
export interface ScriptCatalogEntry {
  /** Stable unique identifier for the script. */
  script_id: string;
  /** Human-readable description of what the script does. */
  description: string;
  /** Execution runtime used to invoke the script. */
  runtime: ScriptRuntime;
  /** Declared mutation scope for safety and policy enforcement. */
  side_effects: SideEffectLevel;
  /** Maximum execution time in milliseconds. */
  timeout_ms: number;
  /** Whether the worker may retry this script on transient failure. */
  retryable: boolean;
  /** Optional free-text hints injected into orchestrator context. */
  orchestrator_notes?: string;
}

// ---------------------------------------------------------------------------
// Script output artifact type
// ---------------------------------------------------------------------------

/**
 * A single output artifact produced by a script execution.
 *
 * Each artifact has a workspace-relative path, a human-readable label,
 * and a format identifier used by downstream consumers for parsing.
 */
export interface ScriptOutputArtifact {
  /** Workspace-relative path where the artifact was written. */
  path: string;
  /** Human-readable label for the artifact. */
  label: string;
  /** Format identifier (e.g., "json", "md", "csv"). */
  format: string;
}

// ---------------------------------------------------------------------------
// Script result envelope type
// ---------------------------------------------------------------------------

/**
 * Structured JSON envelope returned on script stdout.
 *
 * The worker parses this envelope to extract artifacts, state mutations,
 * and execution metrics. Scripts must print exactly one JSON object
 * conforming to this shape on stdout.
 */
export interface ScriptResultEnvelope {
  /** Human-readable summary of what happened during execution. */
  summary: string;
  /** Output file artifacts keyed by logical name. */
  outputs?: Record<string, ScriptOutputArtifact>;
  /** Key-value mutations merged into the persistent run state. */
  state_patch?: Record<string, unknown>;
  /** Execution metrics (e.g., files scanned, estimated cost). */
  metrics?: Record<string, unknown>;
}
