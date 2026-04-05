/**
 * Shared CLI subprocess backend for agent execution.
 *
 * Provides the core lifecycle for spawning CLI agent processes: prompt file
 * writing, subprocess spawn via child_process, stdout/stderr capture, timeout
 * enforcement with process kill, state flag management (pending/completed/failed),
 * and exit code translation to {@link StepOutput}.
 *
 * Each per-provider adapter (cli-claude, cli-codex, cli-gemini) composes with
 * this shared backend by supplying an adapter object that specifies the CLI
 * binary, argument builder, and output capture mode.
 *
 * @module runners/cli-backend
 */

import { spawn } from "node:child_process";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentBackend,
  AgentConfig,
  StepContext,
  StepOutput,
} from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Prefix for temp directories used by CLI backends. */
const TEMP_DIR_PREFIX = "bees-cli-";

/** Valid terminal states for state flag transitions. */
type FlagState = "completed" | "failed";

/**
 * Strip the provider prefix from a model identifier.
 *
 * Splits on the first `/` and returns everything after it. Model identifiers
 * follow the `provider/model-name` convention (e.g., `"anthropic/claude-sonnet-4-20250514"`
 * yields `"claude-sonnet-4-20250514"`). Identifiers with multiple slashes retain
 * the segments after the first (e.g., `"anthropic/claude/experimental"` yields
 * `"claude/experimental"`).
 *
 * @param model - Full model identifier with provider prefix
 * @returns The model name without the provider prefix
 * @throws Error if the model string contains no `/` separator (missing prefix)
 */
export function stripProviderPrefix(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Model identifier "${model}" is missing a provider prefix (expected "provider/model-name" format)`,
    );
  }
  return model.slice(slashIndex + 1);
}

/**
 * Adapter interface for per-provider CLI argument construction.
 *
 * Each CLI backend (claude, codex, gemini) provides an adapter that knows
 * how to build CLI arguments from the agent configuration and how output
 * should be captured after process exit.
 */
export interface CLIAdapter {
  /** CLI binary name (e.g., "claude", "codex", "gemini"). */
  readonly cliCommand: string;

  /**
   * Build the argument array for the CLI command.
   *
   * @param config - Agent configuration with model, effort, permissions, etc.
   * @param promptFilePath - Absolute path to the temp prompt file
   * @param outputFilePath - Absolute path to the output file (used by codex)
   * @returns Array of CLI argument strings
   */
  buildArgs(config: AgentConfig, promptFilePath: string, outputFilePath?: string): string[];

  /** How to capture output: "stdout" reads from process stdout, "file" reads from output file. */
  readonly captureMode: "stdout" | "file";
}

/**
 * Shared CLI agent backend with subprocess lifecycle management.
 *
 * Implements the full subprocess lifecycle: prompt file creation, process spawn,
 * stdout/stderr streaming, timeout enforcement, state flag transitions, and
 * exit code translation. Per-provider behavior is delegated to the adapter.
 */
export class CLIAgentBackend implements AgentBackend {
  readonly name: string;
  private readonly adapter: CLIAdapter;

  /**
   * @param name - Backend identifier (e.g., "cli-claude")
   * @param adapter - Per-provider adapter for CLI argument construction
   */
  constructor(name: string, adapter: CLIAdapter) {
    this.name = name;
    this.adapter = adapter;
  }

  /**
   * Execute a step by spawning the CLI subprocess.
   *
   * The subprocess is spawned synchronously to allow event listener attachment
   * before any async I/O. File operations (prompt writing, state flags) are
   * performed concurrently but do not block the spawn.
   *
   * Lifecycle:
   * 1. Compute temp paths for prompt, output, and state flags
   * 2. Build CLI arguments via the adapter
   * 3. Spawn the subprocess immediately
   * 4. Write prompt file and state flags concurrently
   * 5. Set up timeout enforcement
   * 6. Collect stdout and stderr
   * 7. On close: translate exit code, transition state flag, return StepOutput
   *
   * @param config - Agent configuration for this execution step
   * @param context - Execution context with task/step identifiers
   * @returns StepOutput with captured output, exit code, and optional error
   */
  run(config: AgentConfig, context: StepContext): Promise<StepOutput> {
    const runId = randomUUID().slice(0, 8);
    const tempDir = path.join(tmpdir(), `${TEMP_DIR_PREFIX}${runId}`);
    const paths = buildRunPaths(tempDir, runId, context.stepId);

    const args = this.adapter.buildArgs(config, paths.prompt, paths.output);

    logger.info(`Spawning ${this.adapter.cliCommand} for step ${context.stepId}`, {
      backend: this.name,
      command: this.adapter.cliCommand,
      stepId: context.stepId,
    });

    const childProcess = spawn(this.adapter.cliCommand, args, {
      cwd: tmpdir(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const setupPromise = writePromptAndPendingFlag(
      tempDir,
      paths.prompt,
      paths.pendingFlag,
      context,
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (childProcess.stdout) {
      childProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (childProcess.stderr) {
      childProcess.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill("SIGTERM");
      logger.warn(`Process timed out after ${config.timeoutMs}ms`, {
        backend: this.name,
        stepId: context.stepId,
        timeoutMs: config.timeoutMs,
      });
    }, config.timeoutMs);

    return new Promise<StepOutput>((resolve) => {
      childProcess.on("close", (code: number | null) => {
        clearTimeout(timeoutHandle);

        const exitCode = code ?? 1;
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderrText = Buffer.concat(stderrChunks).toString("utf-8");
        const targetState: FlagState = timedOut || exitCode !== 0 ? "failed" : "completed";

        void setupPromise
          .then(() =>
            transitionStateFlag(paths.pendingFlag, tempDir, context.stepId, runId, targetState),
          )
          .then(async () => {
            const output = await this.resolveOutput(stdoutText, paths.output);
            resolve(buildStepOutput(output, stdoutText, stderrText, exitCode, timedOut, config, context));
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error("State flag transition failed", { error: message, backend: this.name });
            resolve(buildStepOutput(stdoutText, stdoutText, stderrText, exitCode, timedOut, config, context));
          });
      });
    });
  }

  /**
   * Resolve the final output text based on the adapter's capture mode.
   *
   * For stdout-based adapters (Claude, Gemini), returns the collected stdout.
   * For file-based adapters (Codex), reads from the output file with a
   * graceful fallback to stdout if the file read fails.
   *
   * @param stdoutText - Collected stdout content
   * @param outputFilePath - Path to the output file for file-based capture
   * @returns The resolved output text
   */
  private async resolveOutput(stdoutText: string, outputFilePath: string): Promise<string> {
    if (this.adapter.captureMode !== "file") {
      return stdoutText;
    }

    try {
      return await readFile(outputFilePath, "utf-8");
    } catch {
      logger.warn("Failed to read output file, falling back to stdout", {
        outputFilePath,
        backend: this.name,
      });
      return stdoutText;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** File paths derived from a single run's temp directory. */
interface RunPaths {
  readonly prompt: string;
  readonly output: string;
  readonly pendingFlag: string;
}

/**
 * Compute all file paths for a single CLI run.
 *
 * Centralizes path construction so the run method stays focused on
 * orchestrating the subprocess lifecycle.
 *
 * @param tempDir - Base temp directory for this run
 * @param runId - Short UUID identifying this run
 * @param stepId - Step identifier for the state flag filename
 * @returns Object with prompt, output, and pending flag paths
 */
function buildRunPaths(tempDir: string, runId: string, stepId: string): RunPaths {
  return {
    prompt: path.join(tempDir, `prompt-${runId}.md`),
    output: path.join(tempDir, `output-${runId}.txt`),
    pendingFlag: path.join(tempDir, `pending-${stepId}-${runId}.flag`),
  };
}

/**
 * Write prompt file and pending state flag to the temp directory.
 *
 * Creates the temp directory, then writes the prompt content and the
 * pending flag file concurrently. Both writes happen after directory
 * creation to avoid ENOENT errors.
 *
 * @param tempDir - Base temp directory for this run
 * @param promptFilePath - Where to write the prompt content
 * @param pendingFlagPath - Where to write the pending state flag
 * @param context - Step execution context for prompt assembly
 */
async function writePromptAndPendingFlag(
  tempDir: string,
  promptFilePath: string,
  pendingFlagPath: string,
  context: StepContext,
): Promise<void> {
  const promptContent = buildPromptContent(context);
  await mkdir(tempDir, { recursive: true });
  await Promise.all([
    writeFile(promptFilePath, promptContent, "utf-8"),
    writeFile(pendingFlagPath, `pending since ${new Date().toISOString()}`, "utf-8"),
  ]);
}

/**
 * Build a StepOutput from the subprocess execution results.
 *
 * Translates exit code, timeout state, and captured streams into the
 * uniform StepOutput structure. Timeout errors always take precedence
 * over normal failure errors since timeout indicates a resource limit
 * rather than a logic error.
 *
 * @param output - Resolved output text (from stdout or file)
 * @param stdoutText - Raw stdout text (used as fallback output)
 * @param stderrText - Raw stderr text (used for error messages)
 * @param exitCode - Normalized process exit code (never null)
 * @param timedOut - Whether the process was killed due to timeout
 * @param config - Agent config (used for timeout value in error message)
 * @param context - Step context (used for step ID in error message)
 * @returns Fully constructed StepOutput
 */
function buildStepOutput(
  output: string,
  stdoutText: string,
  stderrText: string,
  exitCode: number,
  timedOut: boolean,
  config: AgentConfig,
  context: StepContext,
): StepOutput {
  if (timedOut) {
    return {
      output: stdoutText,
      outputFiles: [],
      error: `Timeout: process killed after ${config.timeoutMs}ms for step ${context.stepId}`,
      exitCode,
    };
  }

  if (exitCode === 0) {
    return {
      output,
      outputFiles: [],
      exitCode: 0,
    };
  }

  return {
    output: stdoutText,
    outputFiles: [],
    error: stderrText || `Process exited with code ${exitCode}`,
    exitCode,
  };
}

/**
 * Build prompt content from the step execution context.
 *
 * Assembles a minimal prompt string from the task payload and prior outputs.
 * The full prompt assembly (with system prompt, skills, etc.) is handled
 * upstream by the prompt-builder module; this creates a fallback representation.
 *
 * @param context - Step execution context
 * @returns Prompt content string
 */
function buildPromptContent(context: StepContext): string {
  const parts: string[] = [];

  if (context.taskPayload) {
    parts.push(JSON.stringify(context.taskPayload, null, 2));
  }

  const priorOutputKeys = Object.keys(context.priorOutputs);
  if (priorOutputKeys.length > 0) {
    parts.push(`Prior outputs: ${JSON.stringify(context.priorOutputs)}`);
  }

  return parts.join("\n\n") || "No prompt content provided";
}

/**
 * Transition a state flag from pending to the target state.
 *
 * Removes the pending flag file and creates a new flag file with the target
 * state name (completed or failed). Silently tolerates a missing pending
 * flag since the process close event may fire before the flag was written.
 *
 * @param pendingFlagPath - Absolute path to the pending flag file
 * @param flagDir - Directory containing flag files
 * @param stepId - Step identifier for the flag filename
 * @param runId - Unique run identifier for the flag filename
 * @param targetState - Target state: "completed" or "failed"
 */
async function transitionStateFlag(
  pendingFlagPath: string,
  flagDir: string,
  stepId: string,
  runId: string,
  targetState: FlagState,
): Promise<void> {
  try {
    await unlink(pendingFlagPath);
  } catch {
    // Pending flag may not exist yet if close fires before setup completes
  }

  const targetFlagPath = path.join(flagDir, `${targetState}-${stepId}-${runId}.flag`);
  await writeFile(targetFlagPath, `${targetState} at ${new Date().toISOString()}`, "utf-8");
}
