/**
 * Agent backend and step execution types for the runner system.
 *
 * Defines the interfaces for pluggable agent backends, step execution context
 * and output, agent configuration, and CLI-specific backend settings. These
 * types form the contract between the dispatcher and individual runners.
 *
 * @module runners/types
 */

import type { CostAccumulator } from "../queue/types.js";

/** Uniform output produced by any runner type (agent, script, tool). */
export interface StepOutput {
  /** Text output from execution. */
  output: string;
  /** File paths produced by execution. */
  outputFiles: string[];
  /** Token usage and cost data (optional, not all runners track cost). */
  cost?: CostAccumulator;
  /** Error message if execution failed. */
  error?: string;
  /** Process exit code for script/CLI runners. */
  exitCode?: number;
}

/** Context passed to a runner for step execution. */
export interface StepContext {
  /** Parent task identifier. */
  taskId: string;
  /** User-provided input data from the task. */
  taskPayload: Record<string, unknown>;
  /** Gate that owns this workflow. */
  gateId: string;
  /** Step being executed. */
  stepId: string;
  /** Filesystem path for the task workspace (if configured). */
  workspacePath?: string;
  /** Outputs from previously completed steps, keyed by step ID. */
  priorOutputs: Record<string, StepOutput>;
}

/** Configuration for agent-type step execution. */
export interface AgentConfig {
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
}

/** CLI-specific configuration extending agent execution. */
export interface CLIBackendConfig {
  /** CLI binary name (e.g., "claude", "codex", "gemini"). */
  cliCommand: string;
  /** Working directory for CLI execution. */
  workingDir?: string;
  /** Environment variables to pass to the CLI process. */
  env?: Record<string, string>;
  /** Path to a prompt file for the CLI. */
  promptFilePath?: string;
  /** Path to write CLI output. */
  outputFilePath?: string;
}

/** Pluggable agent execution backend. */
export interface AgentBackend {
  /** Backend identifier (immutable after creation). */
  readonly name: string;
  /** Execute a step with the given configuration and context. */
  run(config: AgentConfig, context: StepContext): Promise<StepOutput>;
}
