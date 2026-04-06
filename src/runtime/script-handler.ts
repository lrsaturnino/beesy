/**
 * Script execution handler for `script_run` subtasks in the worker dispatch.
 *
 * Bridges the script registry (metadata, env validation) with the subprocess
 * lifecycle in `script-runner.ts`. Adds registry resolution, env validation,
 * stdin payload construction, result envelope parsing, artifact registration,
 * journal events, exit code mapping (0=success, 1=failure, 2=pause), rerun
 * policy enforcement (restart/continue/refuse), schema validation, timeout
 * enforcement, and stderr progress streaming.
 *
 * Follows the same structural pattern as `stage-agent-handler.ts`: a top-level
 * async function that chains resolution, validation, execution, output
 * normalization, and artifact registration in sequence.
 *
 * @module runtime/script-handler
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { runScript } from "../executor/script-runner.js";
import { resolveScript, validateEnvRequirements } from "../scripts/registry.js";
import type { ScriptManifest, ScriptResultEnvelope } from "../scripts/types.js";
import { appendJournalEntry, readJournal } from "./journal.js";
import type { StepContext, StepOutput } from "../runners/types.js";
import type { Task, Subtask } from "../queue/types.js";
import { createStderrBatcher, type StderrBatcherSink } from "../utils/stderr-batcher.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Structured result returned by the script handler after execution. */
export interface ScriptHandlerResult {
  /** Text output from the script execution (envelope summary on success). */
  output: string;
  /** Durable artifact identifiers produced during this execution. */
  artifactIds: string[];
  /** Key-value mutations to merge into persistent task state. */
  statePatch?: Record<string, unknown>;
  /** Present only when execution failed or was blocked. */
  error?: string;
  /** When true, the script requested human input (exit code 2). */
  needsInput?: boolean;
}

// ---------------------------------------------------------------------------
// Error result factory
// ---------------------------------------------------------------------------

/**
 * Build a failed ScriptHandlerResult with a descriptive error message.
 *
 * Centralizes the error-result construction so every early-return path
 * in the handler uses the same shape. Keeps the top-level handler body
 * focused on the happy path and policy logic.
 *
 * @param message - Human-readable error description
 * @returns ScriptHandlerResult with error populated and empty outputs
 */
function errorResult(message: string): ScriptHandlerResult {
  return { output: "", artifactIds: [], error: message };
}

// ---------------------------------------------------------------------------
// Runtime command resolution
// ---------------------------------------------------------------------------

/**
 * Map a script manifest's runtime and path to a shell command string.
 *
 * Resolves workspace-relative script paths against the provided workspace
 * root and selects the appropriate runtime executable:
 * - `python` -> `uv run <path>` (per project convention for reproducible execution)
 * - `node`   -> `node <path>`
 * - `shell`  -> `bash <path>` (also the fallback for unrecognized runtimes)
 *
 * @param manifest      - Script manifest with runtime and path fields
 * @param workspacePath - Workspace root for resolving relative script paths
 * @returns Shell command string ready for subprocess execution
 */
function resolveCommand(manifest: ScriptManifest, workspacePath: string): string {
  const scriptPath = path.join(workspacePath, manifest.path);

  const runtimeCommands: Record<string, string> = {
    python: `uv run ${scriptPath}`,
    node: `node ${scriptPath}`,
    shell: `bash ${scriptPath}`,
  };

  return runtimeCommands[manifest.runtime] ?? `bash ${scriptPath}`;
}

// ---------------------------------------------------------------------------
// Exported helper: stdin payload construction
// ---------------------------------------------------------------------------

/**
 * Build the JSON stdin payload for a script subprocess.
 *
 * Constructs the payload that will be sent via stdin to the script process.
 * Contains the task state (from task.payload), input patch (from subtask
 * payload), and optionally a prior result for continue-policy reruns.
 *
 * @param task        - Parent task whose payload provides the task state
 * @param subtask     - Subtask whose payload provides the input patch
 * @param priorResult - Prior execution result to inject for continue policy
 * @returns Serialized JSON string for subprocess stdin
 */
export function buildScriptStdinPayload(
  task: Task,
  subtask: Subtask,
  priorResult?: unknown,
): string {
  const payload: Record<string, unknown> = {
    task_state: task.payload,
    input_patch: subtask.payload ?? {},
  };

  if (priorResult !== undefined) {
    payload.prior_result = priorResult;
  }

  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// Exported helper: result envelope parsing
// ---------------------------------------------------------------------------

/**
 * Parse the structured result envelope from script stdout.
 *
 * Scripts emit a single JSON object on stdout conforming to the
 * ScriptResultEnvelope schema. This function validates that the parsed
 * object has the required `summary` field.
 *
 * @param raw - Raw stdout string from the subprocess
 * @returns Parsed and validated ScriptResultEnvelope
 * @throws When the stdout is not valid JSON or the summary field is missing
 */
export function parseResultEnvelope(raw: string): ScriptResultEnvelope {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse script result JSON: ${message}`);
  }

  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
    throw new Error("Script result envelope missing required 'summary' field");
  }

  return parsed as unknown as ScriptResultEnvelope;
}

// ---------------------------------------------------------------------------
// Exported helper: exit code mapping
// ---------------------------------------------------------------------------

/**
 * Map a script process exit code to a ScriptHandlerResult.
 *
 * Exit code semantics:
 * - 0: Success -- result populated from parsed envelope
 * - 1: Failure -- error populated from StepOutput error or stderr
 * - 2: Pause -- needsInput flag set, no error treated as failure
 * - Other: Failure with exit code in message
 *
 * @param exitCode   - Process exit code from runScript
 * @param stepOutput - Raw StepOutput from runScript
 * @param envelope   - Parsed result envelope (available only on exit code 0)
 * @returns Structured handler result reflecting the exit code semantics
 */
export function mapScriptExitCode(
  exitCode: number,
  stepOutput: StepOutput,
  envelope?: ScriptResultEnvelope,
): ScriptHandlerResult {
  if (exitCode === 0 && envelope) {
    return {
      output: envelope.summary,
      artifactIds: [],
      statePatch: envelope.state_patch,
    };
  }

  if (exitCode === 1) {
    return {
      output: "",
      artifactIds: [],
      error: stepOutput.error ?? "Script exited with code 1",
    };
  }

  if (exitCode === 2) {
    return {
      output: stepOutput.output,
      artifactIds: [],
      needsInput: true,
    };
  }

  return {
    output: "",
    artifactIds: [],
    error: stepOutput.error ?? `Script exited with code ${exitCode}`,
  };
}

// ---------------------------------------------------------------------------
// Exported helper: rerun policy enforcement
// ---------------------------------------------------------------------------

/**
 * Find the most recent `script_completed` journal entry for a given script.
 *
 * Scans the journal in reverse chronological order and returns the first
 * entry matching the provided script_id. Returns `undefined` when no
 * prior completion exists.
 *
 * @param runsDir  - Base directory containing task run directories
 * @param taskId   - Task identifier for journal lookup
 * @param scriptId - Script identifier to match in journal entries
 * @returns Most recent script_completed entry, or undefined
 */
function findPriorScriptCompletion(
  runsDir: string,
  taskId: string,
  scriptId: string,
): Record<string, unknown> | undefined {
  const journal = readJournal(runsDir, taskId);
  return [...journal]
    .reverse()
    .find(
      (entry) =>
        entry.type === "script_completed" &&
        entry.scriptId === scriptId,
    ) as Record<string, unknown> | undefined;
}

/**
 * Extract the reusable result data from a prior script_completed journal entry.
 *
 * Strips the journal-internal fields (timestamp, type, scriptId) so that
 * only the script's output payload remains for injection into subsequent
 * runs via the `prior_result` stdin field.
 *
 * @param entry - The prior script_completed journal entry
 * @returns Cleaned result data without journal metadata
 */
function extractPriorResultData(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const { timestamp: _ts, type: _type, scriptId: _sid, ...resultData } = entry;
  return resultData;
}

/**
 * Enforce the script's declared rerun policy by checking prior execution history.
 *
 * Reads the task journal to find the most recent `script_completed` entry for
 * the given script_id and applies the manifest's rerun_policy:
 * - `"restart"`: always returns null (fresh execution, ignores prior history)
 * - `"refuse"` + prior exists: returns an error blocking re-execution
 * - `"refuse"` + no prior: returns null (first execution allowed)
 * - `"continue"` + prior exists: returns the prior result for injection into stdin
 * - `"continue"` + no prior: returns null (first run, no prior context)
 *
 * @param manifest - Script manifest with rerun_policy and script_id
 * @param runsDir  - Base directory containing task run directories
 * @param taskId   - Task identifier for journal lookup
 * @returns Policy enforcement result, or null when execution is allowed without prior context
 */
export async function enforceRerunPolicy(
  manifest: ScriptManifest,
  runsDir: string,
  taskId: string,
): Promise<{ error?: string; priorResult?: Record<string, unknown> } | null> {
  if (manifest.rerun_policy === "restart") {
    return null;
  }

  const priorEntry = findPriorScriptCompletion(runsDir, taskId, manifest.script_id);

  if (manifest.rerun_policy === "refuse") {
    if (priorEntry) {
      return {
        error: `Re-execution refused: script "${manifest.script_id}" has already completed. Rerun policy is "refuse".`,
      };
    }
    return null;
  }

  if (manifest.rerun_policy === "continue") {
    if (priorEntry) {
      return { priorResult: extractPriorResultData(priorEntry) };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exported helper: lightweight schema validation
// ---------------------------------------------------------------------------

/**
 * Collect missing-field violations from a schema's required array.
 *
 * @param payload  - Object to validate against
 * @param required - Array of field names that must exist in the payload
 * @returns Array of violation descriptions (empty when all present)
 */
function checkRequiredFields(
  payload: Record<string, unknown>,
  required: unknown,
): string[] {
  if (!Array.isArray(required)) return [];

  const violations: string[] = [];
  for (const field of required) {
    if (typeof field === "string" && !(field in payload)) {
      violations.push(`Missing required field: "${field}"`);
    }
  }
  return violations;
}

/**
 * Collect type-mismatch violations from a schema's properties definition.
 *
 * Only validates properties that exist in the payload and have a declared
 * type in the schema. Missing properties are not flagged here -- that is
 * handled by {@link checkRequiredFields}.
 *
 * @param payload    - Object to validate
 * @param properties - Schema properties definition with optional type declarations
 * @returns Array of violation descriptions (empty when all types match)
 */
function checkPropertyTypes(
  payload: Record<string, unknown>,
  properties: unknown,
): string[] {
  if (!properties || typeof properties !== "object") return [];

  const violations: string[] = [];
  const props = properties as Record<string, Record<string, unknown>>;
  for (const [key, propDef] of Object.entries(props)) {
    if (key in payload && propDef.type && typeof propDef.type === "string") {
      const actual = typeof payload[key];
      if (actual !== propDef.type) {
        violations.push(
          `Field "${key}" expected type "${propDef.type}" but got "${actual}"`,
        );
      }
    }
  }
  return violations;
}

/**
 * Validate an object against a lightweight JSON Schema-like definition.
 *
 * Checks two aspects when present in the schema:
 * 1. Required fields: all keys listed in `schema.required` must exist in the payload
 * 2. Property types: for each key in `schema.properties` that has a `"type"` field,
 *    verifies that `typeof payload[key]` matches the declared type
 *
 * This is intentionally lightweight (no nested object validation, no array
 * item checks, no regex patterns) to avoid introducing a JSON Schema library
 * dependency. Sufficient for the current script input/output contracts.
 *
 * @param payload - Object to validate
 * @param schema  - Schema definition with optional `required` and `properties` fields
 * @returns null when valid, or a descriptive error string when validation fails
 */
export function validatePayloadSchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const violations = [
    ...checkRequiredFields(payload, schema.required),
    ...checkPropertyTypes(payload, schema.properties),
  ];

  return violations.length > 0
    ? `Schema validation failed: ${violations.join("; ")}`
    : null;
}

// ---------------------------------------------------------------------------
// Artifact registration
// ---------------------------------------------------------------------------

/**
 * Register script output artifacts with durable UUIDs and journal entries.
 *
 * For each artifact in the envelope outputs, generates a UUID via
 * `crypto.randomUUID()`, writes the artifact metadata as JSON to the
 * task's artifact directory, and appends an `artifact_registered` journal
 * entry. The artifact file contains the label and workspace-relative path
 * so downstream consumers can locate the original file.
 *
 * @param outputs  - Map of artifact name to ScriptOutputArtifact from the envelope
 * @param task     - Parent task for directory and journal context
 * @param scriptId - Script identifier for journal entry context
 * @param runsDir  - Base directory for task run data
 * @returns Array of registered artifact IDs
 */
async function registerArtifacts(
  outputs: Record<string, { path: string; label: string; format: string }>,
  task: Task,
  scriptId: string,
  runsDir: string,
): Promise<string[]> {
  const artifactIds: string[] = [];
  const artifactsDir = path.join(runsDir, task.id, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  for (const [_name, artifact] of Object.entries(outputs)) {
    const artifactId = randomUUID();
    const filePath = path.join(artifactsDir, `${artifactId}.${artifact.format}`);
    const metadata = JSON.stringify({ label: artifact.label, path: artifact.path });

    await writeFile(filePath, metadata, "utf-8");
    artifactIds.push(artifactId);

    appendJournalEntry(runsDir, task.id, {
      type: "artifact_registered",
      artifactId,
      label: artifact.label,
      format: artifact.format,
      scriptId,
    });
  }

  return artifactIds;
}

// ---------------------------------------------------------------------------
// Success path: envelope processing and artifact registration
// ---------------------------------------------------------------------------

/**
 * Process a successful script execution result (exit code 0).
 *
 * Parses the stdout envelope, validates against the output schema when
 * defined, registers output artifacts, and journals the completion event.
 * Returns the assembled handler result or an error if any step fails.
 *
 * Extracted from the main handler body to reduce nesting depth and
 * isolate the success-path logic into a focused, testable unit.
 *
 * @param stepOutput - Raw StepOutput from runScript with exitCode 0
 * @param manifest   - Script manifest for schema validation and metadata
 * @param task       - Parent task for artifact storage context
 * @param subtask    - Subtask being processed for journal context
 * @param scriptId   - Script identifier for journal entries
 * @param runsDir    - Base directory for task run data
 * @returns Structured handler result with output, artifacts, and state patch
 */
async function processSuccessEnvelope(
  stepOutput: StepOutput,
  manifest: ScriptManifest,
  task: Task,
  subtask: Subtask,
  scriptId: string,
  runsDir: string,
): Promise<ScriptHandlerResult> {
  // Parse the result envelope from stdout
  let envelope: ScriptResultEnvelope;
  try {
    envelope = parseResultEnvelope(stepOutput.output);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appendJournalEntry(runsDir, task.id, {
      type: "script_failed",
      scriptId,
      subtaskId: subtask.id,
      error: message,
    });
    return { output: stepOutput.output, artifactIds: [], error: message };
  }

  // Validate output against output_schema when defined
  if (manifest.output_schema) {
    const outputPayload: Record<string, unknown> = {};
    if (envelope.outputs) {
      for (const [key, value] of Object.entries(envelope.outputs)) {
        outputPayload[key] = value;
      }
    }
    const schemaError = validatePayloadSchema(outputPayload, manifest.output_schema);
    if (schemaError) {
      const errorMsg = `Output schema validation failed for script "${scriptId}": ${schemaError}`;
      appendJournalEntry(runsDir, task.id, {
        type: "script_failed",
        scriptId,
        subtaskId: subtask.id,
        error: errorMsg,
      });
      return { output: envelope.summary, artifactIds: [], error: errorMsg };
    }
  }

  // Register artifacts from envelope outputs
  let artifactIds: string[] = [];
  if (envelope.outputs && Object.keys(envelope.outputs).length > 0) {
    artifactIds = await registerArtifacts(
      envelope.outputs as Record<string, { path: string; label: string; format: string }>,
      task,
      scriptId,
      runsDir,
    );
  }

  // Journal the successful completion with full context
  appendJournalEntry(runsDir, task.id, {
    type: "script_completed",
    scriptId,
    subtaskId: subtask.id,
    summary: envelope.summary,
    output: envelope.outputs,
    statePatch: envelope.state_patch,
    metrics: envelope.metrics,
  });

  return {
    output: envelope.summary,
    artifactIds,
    statePatch: envelope.state_patch,
  };
}

// ---------------------------------------------------------------------------
// Top-level handler
// ---------------------------------------------------------------------------

/**
 * Handle a `script_run` subtask by orchestrating the full script lifecycle.
 *
 * Chains the following operations in sequence:
 * 1. Extract script_id from subtask payload
 * 2. Resolve script manifest from registry
 * 3. Validate required environment variables
 * 4. Enforce rerun policy (refuse/restart/continue)
 * 5. Build stdin payload with task state, input patch, and optional prior result
 * 6. Validate stdin against input_schema when defined
 * 7. Journal script_started
 * 8. Build StepContext and resolve command
 * 9. Invoke runScript with command, env, context, onStderr, and timeout
 * 10. Map exit code to handler result
 * 11. On success: parse envelope, validate output_schema, register artifacts, journal completion
 * 12. On failure: journal failure, return error
 * 13. On pause: return needsInput signal
 *
 * @param task       - Parent task containing payload and workspace
 * @param subtask    - The script_run subtask with script_id in payload
 * @param registry   - Script registry Map for manifest resolution
 * @param runsDir    - Base directory for task run data and artifact storage
 * @param onProgress - Optional progress sink for stderr streaming via batcher
 * @returns Structured handler result with output, artifacts, and status signals
 */
export async function handleScriptRun(
  task: Task,
  subtask: Subtask,
  registry: Map<string, ScriptManifest>,
  runsDir: string,
  onProgress?: StderrBatcherSink,
): Promise<ScriptHandlerResult> {
  // Step 1: Extract script_id from subtask payload
  const scriptId = (subtask.payload as Record<string, unknown>)?.script_id as string;
  if (!scriptId) {
    return errorResult("Subtask payload missing required 'script_id' field");
  }

  // Step 2: Resolve manifest from registry
  const manifest = resolveScript(registry, scriptId);
  if (!manifest) {
    return errorResult(`Unknown script_id "${scriptId}": not found in registry`);
  }

  // Step 3: Validate required environment variables before process spawn
  const envResult = validateEnvRequirements(registry, scriptId);
  if (envResult && !envResult.valid) {
    return errorResult(
      `Missing required environment variables for script "${scriptId}": ${envResult.missing.join(", ")}`,
    );
  }

  // Step 4: Enforce rerun policy (refuse/restart/continue)
  const policyResult = await enforceRerunPolicy(manifest, runsDir, task.id);
  if (policyResult?.error) {
    return errorResult(policyResult.error);
  }

  // Step 5: Build stdin payload with optional prior result from continue policy
  const priorResult = policyResult?.priorResult;
  const stdinPayload = buildScriptStdinPayload(task, subtask, priorResult);

  // Step 6: Validate stdin against input_schema when defined
  if (manifest.input_schema) {
    const parsedPayload = JSON.parse(stdinPayload) as Record<string, unknown>;
    const schemaError = validatePayloadSchema(parsedPayload, manifest.input_schema);
    if (schemaError) {
      return errorResult(
        `Input schema validation failed for script "${scriptId}": ${schemaError}`,
      );
    }
  }

  // Step 7: Journal script_started
  appendJournalEntry(runsDir, task.id, {
    type: "script_started",
    scriptId,
    subtaskId: subtask.id,
  });

  // Step 8: Build StepContext and resolve command
  const taskPayload = JSON.parse(stdinPayload) as Record<string, unknown>;
  const context: StepContext = {
    taskId: task.id,
    taskPayload,
    gateId: task.gate,
    stepId: subtask.stepId,
    workspacePath: task.workspacePath,
    priorOutputs: {},
  };

  const command = resolveCommand(manifest, task.workspacePath ?? "");

  // Step 9: Set up stderr batcher and invoke runScript
  let onStderr: ((lines: string[]) => void) | undefined;
  let batcher: { dispose: () => Promise<void> } | undefined;

  if (onProgress) {
    const stderrBatcher = createStderrBatcher(onProgress);
    batcher = stderrBatcher;
    onStderr = (lines: string[]) => {
      stderrBatcher.push(lines);
    };
  }

  let stepOutput: StepOutput;
  try {
    stepOutput = await runScript(command, undefined, context, onStderr, manifest.timeout_ms);
  } finally {
    if (batcher) {
      await batcher.dispose();
    }
  }

  // Step 10-13: Map exit code to handler result
  const exitCode = stepOutput.exitCode ?? 1;

  // Exit code 1: failure -- journal and return error
  if (exitCode === 1) {
    appendJournalEntry(runsDir, task.id, {
      type: "script_failed",
      scriptId,
      subtaskId: subtask.id,
      error: stepOutput.error ?? "Script exited with code 1",
    });
    return mapScriptExitCode(1, stepOutput);
  }

  // Exit code 2: pause -- return needs_input signal for worker
  if (exitCode === 2) {
    return mapScriptExitCode(2, stepOutput);
  }

  // Exit code 0: parse envelope, validate output schema, register artifacts
  return processSuccessEnvelope(stepOutput, manifest, task, subtask, scriptId, runsDir);
}
