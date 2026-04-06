/**
 * Push-branch delivery action for the delivery pipeline.
 *
 * Pushes a local git branch to a remote repository via subprocess,
 * validates GITHUB_TOKEN presence (env-key-check only), and returns a
 * result envelope with remote branch details. Repeated push is
 * idempotent: fast-forward pushes succeed silently.
 *
 * Security model:
 * - The GITHUB_TOKEN is validated for presence via key-check only.
 * - The subprocess inherits process.env, so git can use the token
 *   through its standard credential mechanism without the application
 *   code reading the value into a named variable.
 * - Error messages are sanitized as a defense-in-depth measure.
 *
 * Follows the same structural patterns as commit-with-trailers.ts and
 * stage-explicit.ts: typed input/output interfaces, execFileSync-based
 * git subprocess calls, logger integration, and a domain-typed result
 * envelope compatible with ScriptResultEnvelope.
 *
 * @module delivery/push-branch
 */

import { execFileSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input parameters for the pushBranch action. */
export interface PushBranchInput {
  /** Git branch name to push (e.g., "bees/task-001-feature"). */
  readonly branchName: string;
  /** Absolute path to the git workspace directory. */
  readonly workspacePath: string;
  /** Remote name to push to (defaults to "origin"). */
  readonly remote?: string;
}

/**
 * Result returned by the pushBranch action.
 *
 * Shape is compatible with ScriptResultEnvelope (summary + outputs + state_patch)
 * but uses domain-specific output fields for push details.
 */
export interface PushBranchResult {
  /** Human-readable summary of the push operation. */
  readonly summary: string;
  /** Push operation outputs. */
  readonly outputs: {
    /** Fully qualified remote branch reference (e.g., "origin/main"). */
    readonly remoteBranch: string;
    /** Whether the push operation succeeded. */
    readonly pushed: true;
  } | Record<string, never>;
  /** State mutations for downstream task consumption. */
  readonly state_patch?: {
    /** Per-step delivery completion tracking. */
    readonly deliveryStatus: {
      /** Push step completion status. */
      readonly push: "completed" | "failed";
    };
  };
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Timeout for individual git subprocess calls (milliseconds). */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/** Default remote name when none is specified. */
const DEFAULT_REMOTE = "origin";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an unknown error value.
 *
 * Handles both Error instances (extracting `.message`) and arbitrary
 * thrown values (coercing via `String()`).
 *
 * @param err - The caught error value (typically from a catch clause)
 * @returns A human-readable string describing the error
 */
function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a git command in the specified working directory.
 *
 * Uses execFileSync to avoid shell invocation. All git subprocess calls
 * route through this function to ensure consistent timeout, stdio, and
 * encoding settings.
 *
 * @param args - Git command arguments (e.g., ["push", "--set-upstream", "origin", "main"])
 * @param cwd - Working directory for the git process
 * @returns Trimmed stdout from the git command
 */
function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    encoding: "utf-8",
  }).trim();
}

/**
 * Build an error result envelope with empty outputs.
 *
 * Centralizes the error-result construction so every validation and
 * failure path uses the same shape. Keeps the top-level function body
 * focused on the happy path.
 *
 * @param summary - Human-readable error description
 * @returns PushBranchResult with error summary and empty outputs
 */
function errorResult(summary: string): PushBranchResult {
  return { summary, outputs: {} };
}

/**
 * Validate the required input fields for a push operation.
 *
 * Checks branchName and workspacePath for non-empty values. Returns
 * an error result on the first invalid field, or null when all inputs
 * are valid.
 *
 * @param branchName - Branch name to validate
 * @param workspacePath - Workspace path to validate
 * @returns Error result when validation fails, null when inputs are valid
 */
function validateInputs(
  branchName: string,
  workspacePath: string,
): PushBranchResult | null {
  if (!workspacePath || workspacePath.trim().length === 0) {
    logger.error("pushBranch called with empty workspacePath");
    return errorResult("Error: missing or empty workspacePath");
  }

  if (!branchName || branchName.trim().length === 0) {
    logger.error("pushBranch called with empty branchName");
    return errorResult("Error: missing or empty branchName");
  }

  return null;
}

/**
 * Validate that the GITHUB_TOKEN environment variable is present.
 *
 * Performs an env-key presence check via the `in` operator only. The
 * token value is never assigned to a variable here; the subprocess
 * inherits `process.env` automatically, so git can consume the token
 * through its standard credential mechanism.
 *
 * This validation runs before any git subprocess is spawned, ensuring
 * a clear failure message when the token is absent.
 *
 * @returns Error result when GITHUB_TOKEN is not set, null when present
 */
function validateGithubToken(): PushBranchResult | null {
  if (!("GITHUB_TOKEN" in process.env)) {
    logger.error("GITHUB_TOKEN environment variable is not set");
    return errorResult("Error: GITHUB_TOKEN is missing. Set the environment variable before pushing.");
  }

  return null;
}

/**
 * Sanitize an error message to prevent token leakage.
 *
 * Checks whether the GITHUB_TOKEN value appears in the message and
 * replaces all occurrences with a redacted placeholder. This is a
 * defense-in-depth measure since the token is never placed in git
 * command arguments and `execFileSync` with array args avoids shell
 * interpolation.
 *
 * The token read is intentionally confined to a short-lived scope
 * within the conditional check to minimize the window during which
 * the value exists in application memory.
 *
 * @param message - Raw error message that may contain sensitive data
 * @returns Sanitized message with any token occurrences redacted
 */
function sanitizeErrorMessage(message: string): string {
  if ("GITHUB_TOKEN" in process.env && process.env.GITHUB_TOKEN) {
    // Short-lived read: replace and discard immediately
    return message.replaceAll(process.env.GITHUB_TOKEN, "[REDACTED]");
  }
  return message;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push a local git branch to a remote repository.
 *
 * Execution flow:
 * 1. Validate required input fields (branchName, workspacePath)
 * 2. Validate GITHUB_TOKEN env-key presence (never reads the value)
 * 3. Run `git push --set-upstream <remote> <branch>` via subprocess
 * 4. Return a result envelope with remote branch reference and delivery status
 *
 * Idempotency: repeated pushes to the same remote branch succeed when
 * the remote is fast-forwardable, satisfying the "restart" rerun policy.
 *
 * Error handling follows envelope-based reporting: errors are returned in
 * the result summary rather than thrown, matching the stage-explicit.ts
 * and commit-with-trailers.ts patterns. All error messages are sanitized
 * to prevent token leakage.
 *
 * @param input - Push parameters including branch name, workspace path, and optional remote
 * @returns Result envelope with push details or error description
 */
export async function pushBranch(
  input: PushBranchInput,
): Promise<PushBranchResult> {
  const { branchName, workspacePath, remote } = input;
  const targetRemote = remote ?? DEFAULT_REMOTE;

  // Validate required input fields
  const validationError = validateInputs(branchName, workspacePath);
  if (validationError) {
    return validationError;
  }

  // Validate GITHUB_TOKEN presence before any remote operation
  const tokenError = validateGithubToken();
  if (tokenError) {
    return tokenError;
  }

  // Execute git push with --set-upstream for tracking configuration
  try {
    runGit(
      ["push", "--set-upstream", targetRemote, branchName],
      workspacePath,
    );
  } catch (err: unknown) {
    const rawMessage = extractErrorMessage(err);
    const safeMessage = sanitizeErrorMessage(rawMessage);
    logger.error("Git push failed", { branchName, remote: targetRemote, error: safeMessage });
    return errorResult(`Error: git push failed for branch ${branchName}: ${safeMessage}`);
  }

  const remoteBranch = `${targetRemote}/${branchName}`;
  const summary = `Pushed branch ${branchName} to ${targetRemote}`;
  logger.info(summary, { branchName, remote: targetRemote, remoteBranch });

  return {
    summary,
    outputs: { remoteBranch, pushed: true },
    state_patch: { deliveryStatus: { push: "completed" } },
  };
}
