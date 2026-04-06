/**
 * Gate configuration types modeling the YAML schema.
 *
 * These types faithfully represent the gate YAML configuration format, including
 * gate metadata, input specifications, workflow definitions, step execution
 * strategies (using a discriminated union), and optional workspace configuration.
 *
 * @module gates/types
 */

/** Metadata section of a gate configuration. */
export interface GateMetadata {
  /** Unique gate identifier. */
  id: string;
  /** Human-readable gate name. */
  name: string;
  /** Slash command that triggers this gate (e.g., "/new-implementation"). */
  command: string;
  /** Description of what this gate does. */
  description: string;
  /** Whether the gate is enabled (defaults to true). */
  enabled?: boolean;
}

/**
 * An input field entry in the gate configuration.
 *
 * In the YAML schema, each input field is a key-value pair where the key is the
 * field name and the value is an object with a description. The field name is
 * carried as the object key in the containing array or record.
 */
export interface GateInputField {
  /** Human-readable description of what this input field expects. */
  description: string;
}

/** Input specification section of a gate configuration. */
export interface GateInput {
  /** Required input fields. */
  required: GateInputField[];
  /** Optional input fields. */
  optional?: GateInputField[];
}

/** Valid human checkpoint action types. */
export type HumanCheckpointAction = "discuss_and_confirm" | "approve_or_adjust";

/** A checkpoint where human review is required before proceeding. */
export interface HumanCheckpoint {
  /** Step ID after which to pause for review. */
  after: string;
  /** Type of human action required at this checkpoint. */
  action: HumanCheckpointAction;
  /** Message displayed to the reviewer. */
  message: string;
  /** Hours to wait before timing out (defaults to 4). */
  timeoutHours?: number;
}

/** Workflow section defining step execution order. */
export interface GateWorkflow {
  /** Ordered list of step IDs to execute. */
  steps: string[];
  /** Points where human review is required. */
  humanCheckpoints?: HumanCheckpoint[];
}

/** Execution configuration for agent-type steps. */
export interface AgentStepExecution {
  /** Discriminant field identifying this as an agent execution. */
  type: "agent";
  /** Agent configuration (model, tools, timeout, etc.). */
  config: {
    /** Model identifier (e.g., "anthropic/claude-sonnet-4-20250514"). */
    model: string;
    /** Tools available to the agent. */
    tools: string[];
    /** Maximum execution time in milliseconds. */
    timeoutMs: number;
    /** Backend to use for execution (optional, resolved at runtime). */
    backend?: string;
    /** Effort level for the agent. */
    effort?: string;
    /** Permission scope for the agent. */
    permissions?: string;
    /** Skills available to the agent. */
    skills?: string[];
    /** System prompt override. */
    systemPrompt?: string;
    /** Output format specification. */
    outputFormat?: string;
  };
}

/** Execution configuration for script-type steps. */
export interface ScriptStepExecution {
  /** Discriminant field identifying this as a script execution. */
  type: "script";
  /** Shell command to execute. */
  command: string;
  /** Environment variables for the script process. */
  env?: Record<string, string>;
  /** Maximum execution time in milliseconds. */
  timeoutMs: number;
}

/** Execution configuration for tool-type steps. */
export interface ToolStepExecution {
  /** Discriminant field identifying this as a tool execution. */
  type: "tool";
  /** Module path containing the tool function. */
  module: string;
  /** Function name to invoke. */
  function: string;
  /** Arguments to pass to the tool function. */
  args?: Record<string, unknown>;
}

/** Discriminated union of step execution strategies. */
export type StepExecution =
  | AgentStepExecution
  | ScriptStepExecution
  | ToolStepExecution;

/** Definition of a single step in the gate workflow. */
export interface StepDefinition {
  /** Execution strategy and configuration. */
  execution: StepExecution;
  /** Files required as input for this step. */
  inputFiles?: string[];
  /** Files produced as output by this step. */
  outputFiles?: string[];
  /** Description of step behavior. */
  behavior?: string;
  /** Retry configuration for the step (maxRetries = 0 means no retries). */
  retryPolicy?: { maxRetries: number };
}

/** Workspace configuration for git-backed task execution. */
export interface GateWorkspaceConfig {
  /** Repository URL or path. */
  repo: string;
  /** Branch name prefix for task branches (defaults to "bees/"). */
  branchPrefix?: string;
  /** Working directory within the repository (defaults to ".bees/"). */
  workingDir?: string;
  /** Git identity for commits made by the platform. */
  gitIdentity?: {
    /** Committer display name. */
    name: string;
    /** Committer email address. */
    email: string;
    /** Environment variable name holding the Git auth token. */
    tokenEnv: string;
  };
  /** File patterns to preserve as artifacts after task completion. */
  artifacts?: string[];
}

/** Top-level gate configuration modeling the YAML schema. */
export interface GateConfig {
  /** Gate metadata (id, name, command, description). */
  gate: GateMetadata;
  /** Input specification (required and optional fields). */
  input: GateInput;
  /** Workflow definition (step order and checkpoints). */
  workflow: GateWorkflow;
  /** Step definitions keyed by step ID. */
  steps: Record<string, StepDefinition>;
  /** Workspace configuration for git-backed execution (optional). */
  workspace?: GateWorkspaceConfig;
}
