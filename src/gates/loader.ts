/**
 * Gate YAML configuration loader with comprehensive validation.
 *
 * Reads .yaml files from a gates directory, parses them into GateConfig
 * objects, resolves scoped {{env.VAR}} templates in script step env fields,
 * validates against schema rules, and returns structured results with loaded
 * configs, errors, and warnings.
 *
 * @module gates/loader
 */

import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GateConfig } from "./types.js";

/** A validation message from the gate loader. */
export interface ValidationMessage {
  /** Whether this is a fatal error or a non-fatal warning. */
  severity: "error" | "warning";
  /** The file that produced this message. */
  file: string;
  /** Human-readable description of the issue. */
  message: string;
}

/** Result returned by the gate loader. */
export interface LoadGatesResult {
  /** Successfully loaded and validated gate configurations. */
  configs: GateConfig[];
  /** Fatal validation failures preventing gate loading. */
  errors: ValidationMessage[];
  /** Non-fatal issues flagged for attention. */
  warnings: ValidationMessage[];
}

/** Options for the gate loader. */
export interface LoadGatesOptions {
  /** Project root directory for resolving skills/ and input file paths. */
  projectRoot?: string;
}

/** Allowed execution types for step definitions. */
const VALID_EXECUTION_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "script",
  "tool",
]);

/**
 * Pattern matching {{env.VAR_NAME}} templates where VAR_NAME follows
 * POSIX environment variable naming: starts with a letter or underscore,
 * followed by letters, digits, or underscores.
 */
const ENV_TEMPLATE_PATTERN = /\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Convert a snake_case string to camelCase.
 *
 * Handles multi-segment keys like "branch_prefix" -> "branchPrefix".
 * Keys already in camelCase (e.g., "timeoutMs") pass through unchanged.
 */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * Recursively transform all object keys from snake_case to camelCase.
 *
 * Handles nested objects and arrays. Primitive values pass through unchanged.
 */
function transformKeys(value: unknown, preserveChildKeys = false): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => transformKeys(v, false));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const outputKey = preserveChildKeys ? key : snakeToCamel(key);
      // Preserve step ID keys (user-defined identifiers, not schema fields)
      const isStepIdMap = key === "steps" && val !== null && typeof val === "object" && !Array.isArray(val);
      result[outputKey] = transformKeys(val, isStepIdMap);
    }
    return result;
  }
  return value;
}

/**
 * Validate required fields for an agent-type step execution.
 * Agent steps require a config object containing model, tools, and timeoutMs.
 */
function validateAgentExecution(
  execution: Record<string, unknown>,
  stepId: string,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];
  const config = execution.config as Record<string, unknown> | undefined;

  if (!config) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.config is missing -- agent steps require a config object`,
    });
    return errors;
  }

  if (!config.model) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.config.model is missing -- agent config requires a model identifier`,
    });
  }
  if (!config.tools) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.config.tools is missing -- agent config requires a tools array`,
    });
  }
  if (config.timeoutMs === undefined || config.timeoutMs === null) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.config.timeoutMs is missing -- every step requires a timeout`,
    });
  }

  return errors;
}

/**
 * Validate required fields for a script-type step execution.
 * Script steps require a command string and timeoutMs.
 */
function validateScriptExecution(
  execution: Record<string, unknown>,
  stepId: string,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];

  if (!execution.command) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.command is missing -- script steps require a command`,
    });
  }
  if (execution.timeoutMs === undefined || execution.timeoutMs === null) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.timeoutMs is missing -- every step requires a timeout`,
    });
  }

  return errors;
}

/**
 * Validate required fields for a tool-type step execution.
 * Tool steps require both a module path and a function name.
 */
function validateToolExecution(
  execution: Record<string, unknown>,
  stepId: string,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];

  if (!execution.module) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.module is missing -- tool steps require a module path`,
    });
  }
  if (!execution.function) {
    errors.push({
      severity: "error",
      file: filename,
      message: `steps.${stepId}.execution.function is missing -- tool steps require a function name`,
    });
  }

  return errors;
}

/** Dispatch table mapping execution type to its validator function. */
const EXECUTION_VALIDATORS: Record<
  string,
  (
    execution: Record<string, unknown>,
    stepId: string,
    filename: string,
  ) => ValidationMessage[]
> = {
  agent: validateAgentExecution,
  script: validateScriptExecution,
  tool: validateToolExecution,
};

/**
 * Validate gate metadata fields (id and command).
 */
function validateGateMetadata(
  gate: Record<string, unknown> | undefined,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];

  if (!gate?.id || (typeof gate.id === "string" && gate.id.trim() === "")) {
    errors.push({
      severity: "error",
      file: filename,
      message: "gate.id is missing or empty -- add a unique id field under gate:",
    });
  }

  if (!gate?.command) {
    errors.push({
      severity: "error",
      file: filename,
      message:
        "gate.command is missing -- add a command field starting with / under gate:",
    });
  } else if (
    typeof gate.command === "string" &&
    !gate.command.startsWith("/")
  ) {
    errors.push({
      severity: "error",
      file: filename,
      message: `gate.command "${gate.command}" must start with /`,
    });
  }

  return errors;
}

/**
 * Validate workflow steps are non-empty and all references resolve to step definitions.
 */
function validateWorkflowSteps(
  workflow: Record<string, unknown> | undefined,
  stepDefs: Record<string, unknown> | undefined,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];
  const steps = workflow?.steps;

  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push({
      severity: "error",
      file: filename,
      message:
        "workflow.steps is empty or missing -- add at least one step to the workflow",
    });
    return errors;
  }

  if (stepDefs) {
    for (const stepRef of steps) {
      if (typeof stepRef === "string" && !(stepRef in stepDefs)) {
        errors.push({
          severity: "error",
          file: filename,
          message: `workflow.steps references "${stepRef}" but no matching step definition exists in steps:`,
        });
      }
    }
  }

  return errors;
}

/**
 * Validate each step definition's execution configuration.
 * Checks that the execution type is valid, then delegates to the
 * type-specific validator via the dispatch table.
 */
function validateStepExecutions(
  stepDefs: Record<string, unknown> | undefined,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];

  if (!stepDefs || typeof stepDefs !== "object") {
    return errors;
  }

  for (const [stepId, stepDef] of Object.entries(
    stepDefs as Record<string, Record<string, unknown>>,
  )) {
    if (!stepDef || typeof stepDef !== "object") continue;
    const execution = stepDef.execution as Record<string, unknown> | undefined;
    if (!execution) continue;

    const execType = execution.type as string | undefined;

    if (!execType || !VALID_EXECUTION_TYPES.has(execType)) {
      errors.push({
        severity: "error",
        file: filename,
        message: `steps.${stepId}.execution.type "${execType ?? "undefined"}" is invalid -- must be one of: agent, script, tool`,
      });
      continue;
    }

    const validator = EXECUTION_VALIDATORS[execType];
    errors.push(...validator(execution, stepId, filename));
  }

  return errors;
}

/**
 * Validate that human checkpoint references point to steps listed in workflow.steps.
 * Handles both snake_case and camelCase key names since validation runs on the
 * raw parsed object before key transformation.
 */
function validateHumanCheckpoints(
  workflow: Record<string, unknown> | undefined,
  filename: string,
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];
  const steps = workflow?.steps;

  const humanCheckpoints = (
    workflow?.["human_checkpoints"] ?? workflow?.["humanCheckpoints"]
  ) as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(humanCheckpoints) || !Array.isArray(steps)) {
    return errors;
  }

  for (const checkpoint of humanCheckpoints) {
    const afterStep = checkpoint.after as string | undefined;
    if (afterStep && !steps.includes(afterStep)) {
      errors.push({
        severity: "error",
        file: filename,
        message: `human_checkpoints references step "${afterStep}" which is not in workflow.steps`,
      });
    }
  }

  return errors;
}

/** Result of resolving env var templates in a parsed gate config. */
interface InterpolationResult {
  /** The processed object (same reference, env values mutated in-place). */
  result: Record<string, unknown>;
  /** Errors for missing env vars in required fields (prevent gate loading). */
  errors: ValidationMessage[];
  /** Warnings for missing env vars in optional fields (non-blocking). */
  warnings: ValidationMessage[];
}

/**
 * Resolve a single env value string, replacing all {{env.VAR}} templates with
 * their process.env values. Collects an error for each undefined variable.
 *
 * @returns The resolved string and any errors found during replacement
 */
function resolveEnvTemplates(
  value: string,
  stepId: string,
  envKey: string,
  filename: string,
): { resolved: string; errors: ValidationMessage[] } {
  const errors: ValidationMessage[] = [];

  const resolved = value.replace(ENV_TEMPLATE_PATTERN, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      errors.push({
        severity: "error",
        file: filename,
        message: `steps.${stepId}.execution.env.${envKey}: environment variable "${varName}" is not defined`,
      });
      return match;
    }
    return envValue;
  });

  return { resolved, errors };
}

/**
 * Resolve {{env.VAR_NAME}} templates in script step execution.env values.
 *
 * Scoped interpolation: only string values inside steps.<stepId>.execution.env
 * for script-type steps are processed. All other fields (gate metadata, workspace
 * config, step behavior, descriptions) are left untouched. This prevents
 * accidental materialization of secrets in non-execution fields.
 *
 * Missing environment variables in script step env fields produce errors that
 * prevent gate loading, since a broken env map means a broken script process.
 *
 * @param parsed - Raw parsed YAML object with snake_case keys (pre-transformation)
 * @param filename - Source filename for error message context
 * @returns The processed object plus any errors and warnings collected during interpolation
 */
export function interpolateEnvVars(
  parsed: Record<string, unknown>,
  filename: string,
): InterpolationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  const steps = parsed.steps as Record<string, Record<string, unknown>> | undefined;
  if (!steps || typeof steps !== "object") {
    return { result: parsed, errors, warnings };
  }

  for (const [stepId, stepDef] of Object.entries(steps)) {
    if (!stepDef || typeof stepDef !== "object") continue;
    const execution = stepDef.execution as Record<string, unknown> | undefined;
    if (!execution || execution.type !== "script") continue;

    const env = execution.env as Record<string, string> | undefined;
    if (!env || typeof env !== "object") continue;

    for (const [envKey, envValue] of Object.entries(env)) {
      if (typeof envValue !== "string") continue;

      const { resolved, errors: templateErrors } = resolveEnvTemplates(
        envValue,
        stepId,
        envKey,
        filename,
      );

      if (templateErrors.length > 0) {
        errors.push(...templateErrors);
      } else {
        env[envKey] = resolved;
      }
    }
  }

  return { result: parsed, errors, warnings };
}

/**
 * Validate a single parsed gate configuration by running all validation rules.
 *
 * Does not short-circuit on first error -- collects all validation issues
 * so users can fix everything in one pass.
 */
function validateGateConfig(
  parsed: Record<string, unknown>,
  filename: string,
): ValidationMessage[] {
  const gate = parsed.gate as Record<string, unknown> | undefined;
  const workflow = parsed.workflow as Record<string, unknown> | undefined;
  const stepDefs = parsed.steps as Record<string, unknown> | undefined;

  return [
    ...validateGateMetadata(gate, filename),
    ...validateWorkflowSteps(workflow, stepDefs, filename),
    ...validateStepExecutions(stepDefs, filename),
    ...validateHumanCheckpoints(workflow, filename),
  ];
}

/**
 * Check warning conditions for a loaded gate configuration.
 *
 * Warnings do not prevent a gate from loading but flag potential issues.
 */
async function checkWarnings(
  config: GateConfig,
  filename: string,
  options?: LoadGatesOptions,
): Promise<ValidationMessage[]> {
  const warnings: ValidationMessage[] = [];

  // Warn on disabled gates
  if (config.gate.enabled === false) {
    warnings.push({
      severity: "warning",
      file: filename,
      message: `Gate "${config.gate.id}" is disabled (enabled: false)`,
    });
  }

  // Warn on workspace.repo accessibility (deferred -- always warn when present)
  if (config.workspace?.repo) {
    warnings.push({
      severity: "warning",
      file: filename,
      message: `workspace.repo "${config.workspace.repo}" accessibility not verified at load time`,
    });
  }

  // Warn on high retry counts that may cause excessive execution time
  for (const [stepId, stepDef] of Object.entries(config.steps)) {
    const maxRetries = stepDef.retryPolicy?.maxRetries;
    if (maxRetries !== undefined && maxRetries > 3) {
      warnings.push({
        severity: "warning",
        file: filename,
        message: `steps.${stepId}.retryPolicy.maxRetries is ${maxRetries} (> 3) -- consider reducing retry count`,
      });
    }
  }

  // Check skills directories and input_files only when projectRoot is provided
  if (options?.projectRoot) {
    const projectRoot = options.projectRoot;

    // Warn on skills referenced but not found in skills/ directory
    for (const [_stepId, stepDef] of Object.entries(config.steps)) {
      if (stepDef.execution.type === "agent" && stepDef.execution.config.skills) {
        for (const skill of stepDef.execution.config.skills) {
          const skillPath = path.join(projectRoot, "skills", skill);
          try {
            await access(skillPath);
          } catch {
            warnings.push({
              severity: "warning",
              file: filename,
              message: `Skill directory "${skill}" not found at ${skillPath}`,
            });
          }
        }
      }

      // Warn on input_files that do not exist
      if (stepDef.inputFiles) {
        for (const inputFile of stepDef.inputFiles) {
          const filePath = path.join(projectRoot, inputFile);
          try {
            await access(filePath);
          } catch {
            warnings.push({
              severity: "warning",
              file: filename,
              message: `Input file "${inputFile}" not found at ${filePath}`,
            });
          }
        }
      }
    }
  }

  return warnings;
}

/** Result of parsing and validating a single gate YAML file. */
interface ParsedGateFile {
  /** The validated and transformed config, or null if validation failed. */
  config: GateConfig | null;
  /** Validation errors found in this file. */
  errors: ValidationMessage[];
  /** Validation warnings found in this file. */
  warnings: ValidationMessage[];
}

/**
 * Read, parse, and validate a single gate YAML file.
 *
 * Performs the full pipeline: read file, parse YAML, validate structure,
 * transform keys, and check warnings. Returns a structured result so the
 * caller can aggregate across multiple files.
 */
async function processGateFile(
  filePath: string,
  filename: string,
  options?: LoadGatesOptions,
): Promise<ParsedGateFile> {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    errors.push({
      severity: "error",
      file: filename,
      message: `Failed to read file: ${filePath}`,
    });
    return { config: null, errors, warnings };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({
      severity: "error",
      file: filename,
      message: `YAML parse error: ${msg}`,
    });
    return { config: null, errors, warnings };
  }

  if (!parsed || typeof parsed !== "object") {
    errors.push({
      severity: "error",
      file: filename,
      message: "YAML content is not a valid object",
    });
    return { config: null, errors, warnings };
  }

  const interpolation = interpolateEnvVars(
    parsed as Record<string, unknown>,
    filename,
  );
  errors.push(...interpolation.errors);
  warnings.push(...interpolation.warnings);

  if (interpolation.errors.length > 0) {
    return { config: null, errors, warnings };
  }

  const fileErrors = validateGateConfig(
    interpolation.result,
    filename,
  );

  if (fileErrors.length > 0) {
    return { config: null, errors: fileErrors, warnings };
  }

  const config = transformKeys(interpolation.result) as GateConfig;
  const fileWarnings = await checkWarnings(config, filename, options);

  return { config, errors, warnings: fileWarnings };
}

/**
 * Detect duplicate gate IDs and commands across loaded configurations.
 * Returns errors for each duplicate found.
 */
function detectCrossFileDuplicates(
  configs: GateConfig[],
): ValidationMessage[] {
  const errors: ValidationMessage[] = [];
  const seenIds = new Set<string>();
  const seenCommands = new Set<string>();

  for (const config of configs) {
    const gateId = config.gate.id;
    const gateCmd = config.gate.command;

    if (seenIds.has(gateId)) {
      errors.push({
        severity: "error",
        file: "cross-file",
        message: `Duplicate gate.id "${gateId}" found in multiple gate files`,
      });
    } else {
      seenIds.add(gateId);
    }

    if (seenCommands.has(gateCmd)) {
      errors.push({
        severity: "error",
        file: "cross-file",
        message: `Duplicate gate.command "${gateCmd}" found in multiple gate files`,
      });
    } else {
      seenCommands.add(gateCmd);
    }
  }

  return errors;
}

/**
 * List YAML files from a directory, filtering for .yaml and .yml extensions.
 * Returns an empty array if the directory cannot be read.
 */
async function listYamlFiles(gatesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(gatesDir);
    return entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Load and validate gate configurations from YAML files in a directory.
 *
 * Reads all .yaml and .yml files from the specified directory, parses each
 * into a GateConfig object with snake_case to camelCase key transformation,
 * validates against 13 error conditions and 5 warning conditions, and
 * performs cross-file duplicate detection for gate IDs and commands.
 *
 * @param gatesDir - Path to the directory containing gate YAML files
 * @param options - Optional configuration for validation behavior
 * @returns Structured result with loaded configs, errors, and warnings
 */
export async function loadGates(
  gatesDir: string,
  options?: LoadGatesOptions,
): Promise<LoadGatesResult> {
  const files = await listYamlFiles(gatesDir);

  if (files.length === 0) {
    return { configs: [], errors: [], warnings: [] };
  }

  const configs: GateConfig[] = [];
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  for (const file of files) {
    const filePath = path.join(gatesDir, file);
    const result = await processGateFile(filePath, file, options);

    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.config) {
      configs.push(result.config);
    }
  }

  errors.push(...detectCrossFileDuplicates(configs));

  return { configs, errors, warnings };
}
