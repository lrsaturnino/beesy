/**
 * Tool runner for in-process TypeScript module execution.
 *
 * Dynamically imports a TypeScript module by path, validates the named
 * function export, and invokes it with execution context and optional
 * arguments. The return value is normalized into the uniform
 * {@link StepOutput} structure.
 *
 * Timeout enforcement uses Promise.race with an AbortController-based
 * timer to prevent hung tool functions from blocking the queue.
 *
 * Error handling covers all failure modes:
 * - Module import failure (path not found, syntax error)
 * - Missing or non-callable function export
 * - Runtime errors thrown by the tool function
 * - Timeout exceeded
 *
 * @module executor/tool-runner
 */

import { createLogger } from "../utils/logger.js";
import type { StepContext, StepOutput } from "../runners/types.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Default timeout for tool execution (30 seconds). */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Options for tool runner execution, primarily used for testing hooks.
 *
 * @param importFn  - Override for dynamic import (injectable for test mocking)
 * @param timeoutMs - Timeout override in milliseconds
 */
export interface ToolRunnerOptions {
  /** Custom import function for test injection. Defaults to dynamic import(). */
  importFn?: (modulePath: string) => Promise<Record<string, unknown>>;
  /** Timeout in milliseconds. Defaults to DEFAULT_TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Check whether a value conforms to the StepOutput structure.
 *
 * A valid StepOutput-like object has a string `output` field and an
 * array `outputFiles` field. Additional fields are permitted.
 *
 * @param value - The value to inspect
 * @returns True if the value looks like a StepOutput
 */
function isStepOutputLike(value: unknown): value is StepOutput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.output === "string" && Array.isArray(obj.outputFiles);
}

/**
 * Create a failed StepOutput with the given error message.
 *
 * @param error - Error description
 * @returns StepOutput with empty output and the error field set
 */
function makeFailedOutput(error: string): StepOutput {
  return {
    output: "",
    outputFiles: [],
    error,
  };
}

/** Result of creating a timeout race: the timeout promise and its cleanup handle. */
interface TimeoutRace {
  promise: Promise<never>;
  abort: AbortController;
}

/**
 * Create a timeout promise that rejects after the specified duration.
 *
 * Uses AbortController to enable cleanup when the race resolves
 * before the timeout fires.
 *
 * @param ms - Timeout duration in milliseconds
 * @returns The timeout promise and abort controller for cleanup
 */
function createTimeoutRace(ms: number): TimeoutRace {
  const abort = new AbortController();
  const promise = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool timeout: execution exceeded ${ms}ms`));
    }, ms);

    // Clear the timer if the abort signal fires (main promise won the race)
    abort.signal.addEventListener("abort", () => {
      clearTimeout(timer);
    });
  });

  return { promise, abort };
}

/**
 * Normalize an arbitrary tool return value into a uniform StepOutput.
 *
 * Handles three cases:
 * 1. StepOutput-shaped objects are returned as-is
 * 2. Strings are wrapped into StepOutput.output
 * 3. All other values are JSON-serialized into StepOutput.output
 *
 * @param result - Raw return value from the tool function
 * @returns Normalized StepOutput
 */
function normalizeResult(result: unknown): StepOutput {
  if (isStepOutputLike(result)) {
    return result;
  }

  if (typeof result === "string") {
    return { output: result, outputFiles: [] };
  }

  return {
    output: typeof result === "undefined" ? "" : JSON.stringify(result),
    outputFiles: [],
  };
}

/**
 * Execute an in-process tool function by dynamically importing its module.
 *
 * The primary 4-parameter signature matches the RunnerDeps.runTool interface.
 * An optional 5th parameter provides test hooks for import mocking and
 * timeout configuration.
 *
 * @param modulePath - Module path containing the tool function
 * @param fn         - Exported function name to invoke
 * @param args       - Arguments to pass to the tool function (undefined if none)
 * @param context    - Step execution context
 * @param options    - Optional test hooks (importFn, timeoutMs)
 * @returns Uniform StepOutput with execution results
 */
export async function runTool(
  modulePath: string,
  fn: string,
  args: Record<string, unknown> | undefined,
  context: StepContext,
  options?: ToolRunnerOptions,
): Promise<StepOutput> {
  const importFn = options?.importFn ?? ((path: string) => import(path) as Promise<Record<string, unknown>>);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  // Attempt to import the module
  let mod: Record<string, unknown>;
  try {
    mod = await importFn(modulePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to import tool module", {
      module: modulePath,
      error: message,
    });
    return makeFailedOutput(`Failed to import module "${modulePath}": ${message}`);
  }

  // Validate the named function export exists and is callable
  const toolFn = mod[fn];
  if (typeof toolFn !== "function") {
    const available = Object.keys(mod).filter((k) => typeof mod[k] === "function");
    logger.error("Tool function not found in module", {
      module: modulePath,
      function: fn,
      availableExports: available,
    });
    return makeFailedOutput(
      `Function "${fn}" not found in module "${modulePath}". Available functions: [${available.join(", ")}]`,
    );
  }

  // Execute the tool function with timeout enforcement via Promise.race
  const { promise: timeoutPromise, abort } = createTimeoutRace(timeoutMs);

  try {
    const result = await Promise.race([
      toolFn(args, context),
      timeoutPromise,
    ]);

    // Clean up the timeout timer since the function completed first
    abort.abort();

    const output = normalizeResult(result);

    logger.debug("Tool execution completed", {
      module: modulePath,
      function: fn,
      outputLength: output.output.length,
      fileCount: output.outputFiles.length,
    });

    return output;
  } catch (err: unknown) {
    abort.abort();
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Tool execution failed", {
      module: modulePath,
      function: fn,
      error: message,
    });
    return makeFailedOutput(message);
  }
}
