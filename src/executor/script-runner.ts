/**
 * Script runner for external process (Python/shell) execution.
 *
 * Spawns a subprocess with the configured command, sends execution context
 * as JSON via stdin, captures stdout as a JSON response, collects stderr
 * lines for diagnostic relay, and maps process exit codes to the uniform
 * {@link StepOutput} structure.
 *
 * Exit code semantics:
 * - 0: Success -- stdout parsed as JSON into StepOutput
 * - 1: Failure -- StepOutput with error field populated
 * - 2: Needs input -- recognized and logged, pause semantics deferred
 *
 * The stdin/stdout JSON contract follows the Bees script protocol:
 * - Stdin:  `{ workspace, taskPayload, steps, humanInput? }`
 * - Stdout: `{ output, output_files, cost? }`
 *
 * @module executor/script-runner
 */

import { spawn } from "node:child_process";

import { createLogger } from "../utils/logger.js";
import type { StepContext, StepOutput } from "../runners/types.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Default timeout for script execution (5 minutes). */
const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000;

/** Delay before sending SIGKILL after initial SIGTERM (milliseconds). */
const SIGKILL_GRACE_PERIOD_MS = 2_000;

/** Parsed stdout result with mapped field names and optional error. */
interface ParsedStdout {
  output: string;
  outputFiles: string[];
  cost?: StepOutput["cost"];
  error?: string;
}

/**
 * Build the stdin JSON payload from a StepContext following the Bees script contract.
 *
 * Maps StepContext fields to the expected script input format:
 * - workspacePath -> workspace
 * - taskPayload -> taskPayload
 * - priorOutputs -> steps (stepId -> output string)
 *
 * @param context - Step execution context
 * @returns Serialized JSON string for subprocess stdin
 */
function buildStdinPayload(context: StepContext): string {
  const steps: Record<string, string> = {};
  for (const [stepId, stepOutput] of Object.entries(context.priorOutputs)) {
    steps[stepId] = stepOutput.output;
  }

  const payload: Record<string, unknown> = {
    workspace: context.workspacePath ?? "",
    taskPayload: context.taskPayload,
    steps,
  };

  return JSON.stringify(payload);
}

/**
 * Parse stdout JSON from a subprocess into StepOutput fields.
 *
 * Handles the snake_case to camelCase mapping: `output_files` -> `outputFiles`.
 * Returns a partial StepOutput on parse failure with error details.
 *
 * @param raw - Raw stdout string from the subprocess
 * @returns Parsed fields or error information
 */
function parseStdoutJson(raw: string): ParsedStdout {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      output: typeof parsed.output === "string" ? parsed.output : String(parsed.output ?? ""),
      outputFiles: Array.isArray(parsed.output_files) ? (parsed.output_files as string[]) : [],
      cost: parsed.cost as StepOutput["cost"],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: raw,
      outputFiles: [],
      error: `Failed to parse stdout JSON: ${message}`,
    };
  }
}

/**
 * Map a process exit code and captured output into a uniform StepOutput.
 *
 * Centralizes the exit-code-to-output conversion that previously lived
 * inline inside the close handler, improving readability and testability.
 *
 * @param exitCode    - Process exit code (0 = success, 1 = failure, 2 = needs_input)
 * @param rawStdout   - Raw stdout string from the subprocess
 * @param stderrLines - Collected stderr lines for error context
 * @param command     - Original command string (used in log messages)
 * @returns StepOutput with fields populated according to exit code semantics
 */
function mapExitCodeToOutput(
  exitCode: number,
  rawStdout: string,
  stderrLines: string[],
  command: string,
): StepOutput {
  if (exitCode === 1) {
    const errorMessage =
      stderrLines.length > 0
        ? stderrLines.join("\n")
        : "Script exited with code 1";
    return { output: "", outputFiles: [], error: errorMessage, exitCode: 1 };
  }

  if (exitCode === 2) {
    logger.warn("Script exited with code 2 (needs_input), pause semantics deferred", {
      command,
    });
    return {
      output: "",
      outputFiles: [],
      error: "Script requested human input (exit code 2), pause not implemented",
      exitCode: 2,
    };
  }

  // Any other non-zero exit code is a failure
  if (exitCode !== 0) {
    const errorMessage =
      stderrLines.length > 0
        ? stderrLines.join("\n")
        : `Script exited with code ${exitCode}`;
    return { output: "", outputFiles: [], error: errorMessage, exitCode };
  }

  // Exit code 0: success -- parse stdout JSON
  const parsed = parseStdoutJson(rawStdout);
  if (parsed.error) {
    return {
      output: parsed.output,
      outputFiles: parsed.outputFiles,
      error: parsed.error,
      exitCode: 0,
    };
  }

  logger.debug("Script completed successfully", {
    command,
    outputLength: parsed.output.length,
    fileCount: parsed.outputFiles.length,
  });

  return {
    output: parsed.output,
    outputFiles: parsed.outputFiles,
    cost: parsed.cost,
    exitCode: 0,
  };
}

/**
 * Execute a shell command as a subprocess with stdin/stdout/stderr contract.
 *
 * Spawns the command in a shell, pipes execution context as JSON via stdin,
 * captures stdout as JSON response, collects stderr lines, and maps the
 * process exit code to a uniform StepOutput.
 *
 * The primary 3-parameter signature matches the RunnerDeps.runScript interface.
 * An optional 4th parameter accepts a callback invoked with each batch of
 * stderr lines as they arrive. An optional 5th parameter allows timeout
 * override for testing.
 *
 * @param command   - Shell command string to execute
 * @param env       - Environment variables for the subprocess (merged with process.env)
 * @param context   - Step execution context piped as JSON via stdin
 * @param onStderr  - Optional callback invoked with stderr lines as they arrive
 * @param timeoutMs - Timeout in milliseconds (defaults to 300000)
 * @returns Uniform StepOutput with execution results
 */
export async function runScript(
  command: string,
  env: Record<string, string> | undefined,
  context: StepContext,
  onStderr?: (lines: string[]) => void,
  timeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
): Promise<StepOutput> {
  return new Promise<StepOutput>((resolve) => {
    const stdinPayload = buildStdinPayload(context);

    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrLines: string[] = [];
    let timedOut = false;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    // Set up timeout to kill the subprocess if it exceeds the limit
    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn("Script execution timed out, killing process", {
        command,
        timeoutMs,
      });
      child.kill("SIGTERM");
      // Fallback SIGKILL if SIGTERM does not terminate within the grace period
      sigkillTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_PERIOD_MS);
    }, timeoutMs);

    /**
     * Clear all active timers to prevent resource leaks.
     * Called on both normal completion and error paths.
     */
    function clearTimers(): void {
      clearTimeout(timer);
      if (sigkillTimer !== undefined) {
        clearTimeout(sigkillTimer);
      }
    }

    // Guard against EPIPE if the child exits before stdin is consumed
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        logger.warn("stdin write error", { command, error: err.message });
      }
    });

    // Pipe context as JSON to subprocess stdin, then close the stream
    child.stdin.write(stdinPayload);
    child.stdin.end();

    // Collect stdout data incrementally to avoid buffer overflow
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    // Collect stderr lines for diagnostic relay and forward to optional callback
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      stderrLines.push(...lines);
      if (onStderr) {
        onStderr(lines);
      }
    });

    // Handle process completion or termination
    child.on("close", (code: number | null) => {
      settled = true;
      clearTimers();

      if (stderrLines.length > 0) {
        logger.debug("Script stderr captured", {
          command,
          lineCount: stderrLines.length,
        });
      }

      // Timeout produces a dedicated error StepOutput
      if (timedOut) {
        resolve({
          output: "",
          outputFiles: [],
          error: `Script timeout: execution exceeded ${timeoutMs}ms`,
        });
        return;
      }

      const exitCode = code ?? 1;
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
      resolve(mapExitCodeToOutput(exitCode, rawStdout, stderrLines, command));
    });

    // Handle spawn errors (command not found, permission denied)
    child.on("error", (err: Error) => {
      settled = true;
      clearTimers();
      resolve({
        output: "",
        outputFiles: [],
        error: `Failed to spawn script: ${err.message}`,
      });
    });
  });
}
