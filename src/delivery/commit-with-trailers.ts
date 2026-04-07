/**
 * Conventional commit action with trailer generation for the delivery pipeline.
 *
 * Builds a conventional commit message (type(scope): description), resolves
 * the requesting user's identity for Requested-by and Co-authored-by trailers,
 * configures the bees-bot committer identity, executes git commit, and returns
 * a result envelope with the commit SHA and full message.
 *
 * Follows the same structural patterns as stage-explicit.ts: typed input/output
 * interfaces, execFileSync-based git subprocess calls, logger integration, and
 * a domain-typed result envelope compatible with ScriptResultEnvelope.
 *
 * @module delivery/commit-with-trailers
 */

import { execFileSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";
import {
  resolveUser,
  buildRequestedByTrailer,
  buildCoAuthoredByTrailer,
} from "./bees-user.js";
import type { BeesUser } from "./bees-user.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input parameters for the commitWithTrailers action. */
export interface CommitWithTrailersInput {
  /** Commit description text (used as the subject line body). */
  readonly message: string;
  /** Conventional commit type (feat, fix, docs, chore, etc.). */
  readonly type: string;
  /** Optional conventional commit scope. Empty string treated as absent. */
  readonly scope?: string;
  /** Slack user ID of the person who requested the commit. */
  readonly requestedBy: string;
  /** Absolute path to the git workspace directory. */
  readonly workspacePath: string;
}

/**
 * Result returned by the commitWithTrailers action.
 *
 * Shape is compatible with ScriptResultEnvelope (summary + outputs + state_patch)
 * but uses domain-specific output fields for commit details.
 */
export interface CommitWithTrailersResult {
  /** Human-readable summary of the commit operation. */
  readonly summary: string;
  /** Commit operation outputs. */
  readonly outputs: {
    /** Full 40-character hex SHA of the created commit. */
    readonly commitSha: string;
    /** Complete commit message including subject and trailers. */
    readonly fullMessage: string;
  } | Record<string, never>;
  /** State mutations for downstream task consumption. */
  readonly state_patch?: {
    /** SHA of the commit, for downstream delivery steps. */
    readonly lastCommitSha: string;
  };
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Timeout for individual git subprocess calls (milliseconds). */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/** Default git committer name for bees-bot identity. */
const DEFAULT_GIT_NAME = "bees-bot";

/** Default git committer email for bees-bot identity. */
const DEFAULT_GIT_EMAIL = "bees@t-labs.dev";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an unknown error value.
 * Handles both Error instances and arbitrary thrown values.
 */
function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Strip newlines and collapse whitespace in a string to prevent
 * malformed commit subject lines. Git expects the subject line to
 * be a single line; embedded newlines would split the subject from
 * the trailer block prematurely.
 *
 * @param value - Raw string that may contain newlines or extra whitespace
 * @returns Cleaned string with newlines replaced by spaces and whitespace collapsed
 */
function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Execute a git command in the specified working directory.
 *
 * Uses execFileSync to avoid shell invocation. All git subprocess calls
 * route through this function to ensure consistent timeout, stdio, and
 * encoding settings.
 *
 * @param args - Git command arguments (e.g., ["commit", "-m", message])
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
 * Check whether the workspace has any staged changes ready to commit.
 *
 * @param workspacePath - Absolute path to the git workspace
 * @returns true when at least one file is staged
 */
function hasStagedChanges(workspacePath: string): boolean {
  const output = runGit(["diff", "--cached", "--name-only"], workspacePath);
  return output.length > 0;
}

/**
 * Configure the committer identity in the workspace-local git config.
 *
 * Sets user.name and user.email so that commits are attributed to bees-bot
 * regardless of the global or system git configuration.
 *
 * @param workspacePath - Absolute path to the git workspace
 */
function configureCommitterIdentity(workspacePath: string): void {
  runGit(["config", "user.name", DEFAULT_GIT_NAME], workspacePath);
  runGit(["config", "user.email", DEFAULT_GIT_EMAIL], workspacePath);
}

/**
 * Assemble trailers from a resolved BeesUser or a raw Slack ID fallback.
 *
 * When the user is found in the registry, generates trailers using the
 * bees-user module functions. When the user is not found (null), falls
 * back to the raw Slack ID for the Requested-by trailer.
 *
 * @param user - Resolved BeesUser or null when not in registry
 * @param requestedBy - Raw Slack user ID used as fallback identity
 * @returns Array of trailer strings (Requested-by, optionally Co-authored-by)
 */
function assembleTrailers(
  user: BeesUser | null,
  requestedBy: string,
): string[] {
  const trailers: string[] = [];

  if (user) {
    trailers.push(buildRequestedByTrailer(user));
    const coAuthor = buildCoAuthoredByTrailer(user);
    if (coAuthor) {
      trailers.push(coAuthor);
    }
  } else {
    trailers.push(`Requested-by: ${requestedBy}`);
  }

  return trailers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a conventional commit subject line from type, scope, and message.
 *
 * Produces the format `type(scope): message` when scope is a non-empty string,
 * or `type: message` when scope is absent or empty. All components are
 * sanitized to single-line values so that embedded newlines cannot break
 * the commit message structure.
 *
 * @param message - Commit description text
 * @param type - Conventional commit type (feat, fix, docs, etc.)
 * @param scope - Optional scope; empty string treated as absent
 * @returns Formatted conventional commit subject line
 */
export function buildCommitMessage(
  message: string,
  type: string,
  scope?: string,
): string {
  const cleanType = sanitizeSingleLine(type);
  const cleanMessage = sanitizeSingleLine(message);
  const cleanScope = scope ? sanitizeSingleLine(scope) : "";

  if (cleanScope.length > 0) {
    return `${cleanType}(${cleanScope}): ${cleanMessage}`;
  }
  return `${cleanType}: ${cleanMessage}`;
}

/**
 * Assemble a full commit message from a subject line and trailer strings.
 *
 * Separates the subject from trailers with a blank line per git conventions.
 * When no trailers are present, returns the subject line alone.
 *
 * @param subject - Conventional commit subject line
 * @param trailers - Array of trailer strings
 * @returns Full commit message ready for git commit -m
 */
function assembleFullMessage(subject: string, trailers: string[]): string {
  if (trailers.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trailers.join("\n")}`;
}

/**
 * Build an error result envelope with empty outputs.
 *
 * Centralizes the error-result construction so every validation and
 * failure path uses the same shape. Keeps the top-level function body
 * focused on the happy path.
 *
 * @param summary - Human-readable error description
 * @returns CommitWithTrailersResult with error summary and empty outputs
 */
function errorResult(summary: string): CommitWithTrailersResult {
  return { summary, outputs: {} };
}

/**
 * Validate the required input fields for a commit operation.
 *
 * Checks workspacePath, type, and message for non-empty values. Returns
 * an error result on the first invalid field, or null when all inputs
 * are valid.
 *
 * @param workspacePath - Workspace path to validate
 * @param type - Commit type to validate
 * @param message - Commit message to validate
 * @returns Error result when validation fails, null when inputs are valid
 */
function validateInputs(
  workspacePath: string,
  type: string,
  message: string,
): CommitWithTrailersResult | null {
  if (!workspacePath || workspacePath.trim().length === 0) {
    logger.error("commitWithTrailers called with empty workspacePath");
    return errorResult("Error: missing or empty workspacePath");
  }

  if (!type || type.trim().length === 0) {
    logger.error("commitWithTrailers called with empty type");
    return errorResult("Error: commit type is required (e.g., feat, fix, docs, chore)");
  }

  if (!message || message.trim().length === 0) {
    logger.error("commitWithTrailers called with empty message");
    return errorResult("Error: commit message description is required");
  }

  return null;
}

/**
 * Execute a conventional commit with identity trailers in a git workspace.
 *
 * Validates inputs, checks for staged changes, builds the commit message
 * with trailers, configures the bees-bot committer identity, runs git
 * commit, and returns a result envelope with the commit SHA and full message.
 *
 * Error handling follows envelope-based reporting: errors are returned in
 * the result summary rather than thrown, matching the stage-explicit.ts
 * pattern where callers inspect the result rather than catching exceptions.
 *
 * @param input - Commit parameters including message, type, scope, and workspace path
 * @param users - Map of Slack user IDs to BeesUser identities for trailer resolution
 * @returns Result envelope with commit details or error description
 */
export async function commitWithTrailers(
  input: CommitWithTrailersInput,
  users: Map<string, BeesUser>,
): Promise<CommitWithTrailersResult> {
  const { message, type, scope, requestedBy, workspacePath } = input;

  // Validate required input fields
  const validationError = validateInputs(workspacePath, type, message);
  if (validationError) {
    return validationError;
  }

  // Check for staged changes before attempting to commit
  try {
    if (!hasStagedChanges(workspacePath)) {
      logger.warn("No staged changes in workspace", { workspacePath });
      return errorResult("Error: no staged changes to commit. Stage files before committing.");
    }
  } catch (err: unknown) {
    const errorMsg = extractErrorMessage(err);
    logger.error("Failed to check staged changes", { workspacePath, error: errorMsg });
    return errorResult(`Error checking staged changes in ${workspacePath}: ${errorMsg}`);
  }

  // Build the commit message with trailers
  const subject = buildCommitMessage(message, type, scope);
  const user = resolveUser(users, requestedBy);
  const trailers = assembleTrailers(user, requestedBy);
  const fullMessage = assembleFullMessage(subject, trailers);

  // Configure committer identity before committing
  try {
    configureCommitterIdentity(workspacePath);
  } catch (err: unknown) {
    const errorMsg = extractErrorMessage(err);
    logger.error("Failed to configure committer identity", { workspacePath, error: errorMsg });
    return errorResult(`Error configuring git identity in ${workspacePath}: ${errorMsg}`);
  }

  // Execute the git commit
  try {
    runGit(["commit", "-m", fullMessage], workspacePath);
  } catch (err: unknown) {
    const errorMsg = extractErrorMessage(err);
    logger.error("Git commit failed", { workspacePath, error: errorMsg });
    return errorResult(`Error: git commit failed in ${workspacePath}: ${errorMsg}`);
  }

  // Read the commit SHA from the newly created commit
  let commitSha: string;
  try {
    commitSha = runGit(["rev-parse", "HEAD"], workspacePath);
  } catch (err: unknown) {
    const errorMsg = extractErrorMessage(err);
    logger.error("Failed to read commit SHA after successful commit", { workspacePath, error: errorMsg });
    return errorResult(`Error reading commit SHA in ${workspacePath}: ${errorMsg}`);
  }

  const summary = `Committed ${commitSha.slice(0, 7)}: ${subject}`;
  logger.info(summary, { commitSha, workspacePath });

  return {
    summary,
    outputs: { commitSha, fullMessage },
    state_patch: { lastCommitSha: commitSha },
  };
}
