/**
 * Draft PR upsert action for the delivery pipeline.
 *
 * Creates or updates a GitHub draft pull request for a task branch via
 * the gh CLI subprocess. Uses branch-name-based deduplication: queries
 * for an existing open PR on the branch before deciding to create or
 * update. Returns a result envelope with PR details and a state_patch
 * for downstream task state persistence.
 *
 * Security model:
 * - The GITHUB_TOKEN is validated for presence via key-check only.
 * - The subprocess inherits process.env, so the gh CLI can use the
 *   token through its standard credential mechanism without the
 *   application code reading the value into a named variable.
 * - Error messages are sanitized as a defense-in-depth measure.
 *
 * Follows the same structural patterns as push-branch.ts and
 * commit-with-trailers.ts: typed input/output interfaces,
 * execFileSync-based subprocess calls, logger integration, and a
 * domain-typed result envelope compatible with ScriptResultEnvelope.
 *
 * @module delivery/upsert-draft-pr
 */

import { execFileSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input parameters for the upsertDraftPr action. */
export interface UpsertDraftPrInput {
  /** PR title text. */
  readonly title: string;
  /** PR body/description text. */
  readonly body: string;
  /** Git branch name that the PR targets (e.g., "bees/task-001-feature"). */
  readonly branchName: string;
  /** Absolute path to the git workspace directory. */
  readonly workspacePath: string;
  /** Base branch for the PR (defaults to "main"). */
  readonly baseBranch?: string;
}

/**
 * Result returned by the upsertDraftPr action.
 *
 * Shape is compatible with ScriptResultEnvelope (summary + outputs + state_patch)
 * but uses domain-specific output fields for PR details.
 */
export interface UpsertDraftPrResult {
  /** Human-readable summary of the PR operation. */
  readonly summary: string;
  /** PR operation outputs. */
  readonly outputs: {
    /** URL of the created or updated pull request. */
    readonly prUrl: string;
    /** Numeric pull request identifier. */
    readonly prNumber: number;
    /** Whether the PR was created or updated. */
    readonly action: "created" | "updated";
  } | Record<string, never>;
  /** State mutations for downstream task consumption. */
  readonly state_patch?: {
    /** URL of the pull request for task state persistence. */
    readonly prUrl: string;
    /** Numeric pull request identifier for task state persistence. */
    readonly prNumber: number;
    /** Whether the PR was created or updated. */
    readonly prAction: "created" | "updated";
    /** Per-step delivery completion tracking. */
    readonly deliveryStatus: {
      /** PR step completion status. */
      readonly pr: "completed";
    };
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Metadata for an existing open PR returned by `gh pr list`. */
interface ExistingPr {
  readonly number: number;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Timeout for individual gh subprocess calls (milliseconds). */
const GH_COMMAND_TIMEOUT_MS = 30_000;

/** Default base branch when none is specified. */
const DEFAULT_BASE_BRANCH = "main";

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
 * Execute a gh CLI command in the specified working directory.
 *
 * Uses execFileSync to avoid shell invocation. All gh subprocess calls
 * route through this function to ensure consistent timeout, stdio, and
 * encoding settings.
 *
 * @param args - gh command arguments (e.g., ["pr", "list", "--head", branchName])
 * @param cwd - Working directory for the gh process
 * @returns Trimmed stdout from the gh command
 */
function runGh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    stdio: "pipe",
    timeout: GH_COMMAND_TIMEOUT_MS,
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
 * @returns UpsertDraftPrResult with error summary and empty outputs
 */
function errorResult(summary: string): UpsertDraftPrResult {
  return { summary, outputs: {} };
}

/**
 * Validate the required input fields for a PR upsert operation.
 *
 * Checks title, branchName, and workspacePath for non-empty values.
 * Returns an error result on the first invalid field, or null when
 * all inputs are valid.
 *
 * @param title - PR title to validate
 * @param branchName - Branch name to validate
 * @param workspacePath - Workspace path to validate
 * @returns Error result when validation fails, null when inputs are valid
 */
function validateInputs(
  title: string,
  branchName: string,
  workspacePath: string,
): UpsertDraftPrResult | null {
  if (!title || title.trim().length === 0) {
    logger.error("upsertDraftPr called with empty title");
    return errorResult("Error: missing or empty title");
  }

  if (!branchName || branchName.trim().length === 0) {
    logger.error("upsertDraftPr called with empty branchName");
    return errorResult("Error: missing or empty branchName");
  }

  if (!workspacePath || workspacePath.trim().length === 0) {
    logger.error("upsertDraftPr called with empty workspacePath");
    return errorResult("Error: missing or empty workspacePath");
  }

  return null;
}

/**
 * Validate that the GITHUB_TOKEN environment variable is present.
 *
 * Performs an env-key presence check via the `in` operator only. The
 * token value is never assigned to a variable here; the subprocess
 * inherits `process.env` automatically, so the gh CLI can consume the
 * token through its standard credential mechanism.
 *
 * This validation runs before any gh subprocess is spawned, ensuring
 * a clear failure message when the token is absent.
 *
 * @returns Error result when GITHUB_TOKEN is not set, null when present
 */
function validateGithubToken(): UpsertDraftPrResult | null {
  if (!("GITHUB_TOKEN" in process.env)) {
    logger.error("GITHUB_TOKEN environment variable is not set");
    return errorResult("Error: GITHUB_TOKEN is missing. Set the environment variable before creating a PR.");
  }

  return null;
}

/**
 * Sanitize an error message to prevent token leakage.
 *
 * Checks whether the GITHUB_TOKEN value appears in the message and
 * replaces all occurrences with a redacted placeholder. This is a
 * defense-in-depth measure since the token is never placed in gh
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
    return message.replaceAll(process.env.GITHUB_TOKEN, "[REDACTED]");
  }
  return message;
}

/**
 * Query for an existing open PR on the specified branch.
 *
 * Runs `gh pr list` with structured JSON output to find any open PR
 * whose head branch matches the given branch name. Returns the first
 * match or null when no open PR exists.
 *
 * @param branchName - Branch name to search for open PRs
 * @param cwd - Working directory for the gh process
 * @returns PR metadata if found, null otherwise
 */
function findExistingPr(branchName: string, cwd: string): ExistingPr | null {
  const raw = runGh(
    ["pr", "list", "--head", branchName, "--state", "open", "--json", "number,url", "--limit", "1"],
    cwd,
  );

  const parsed = JSON.parse(raw) as ExistingPr[];
  return parsed.length > 0 ? parsed[0] : null;
}

/**
 * Extract the numeric PR identifier from a GitHub PR URL.
 *
 * Parses the last path segment of the URL (e.g., "99" from
 * "https://github.com/org/repo/pull/99") and validates it is
 * a finite number.
 *
 * @param prUrl - Full PR URL returned by `gh pr create`
 * @returns Parsed PR number
 * @throws Error when the URL does not contain a valid numeric PR identifier
 */
function extractPrNumber(prUrl: string): number {
  const segments = prUrl.split("/");
  const prNumber = parseInt(segments[segments.length - 1], 10);

  if (Number.isNaN(prNumber)) {
    throw new Error(`Unable to parse PR number from URL: ${prUrl}`);
  }

  return prNumber;
}

/**
 * Create a new draft PR on the specified branch.
 *
 * Runs `gh pr create --draft` and parses the resulting URL from stdout.
 * Extracts the PR number from the URL's last path segment.
 *
 * @param title - PR title
 * @param body - PR body/description
 * @param branchName - Head branch for the PR
 * @param baseBranch - Base branch to merge into
 * @param cwd - Working directory for the gh process
 * @returns PR URL and number extracted from the create output
 */
function createDraftPr(
  title: string,
  body: string,
  branchName: string,
  baseBranch: string,
  cwd: string,
): { prUrl: string; prNumber: number } {
  const prUrl = runGh(
    ["pr", "create", "--draft", "--title", title, "--body", body, "--head", branchName, "--base", baseBranch],
    cwd,
  );

  const prNumber = extractPrNumber(prUrl);
  return { prUrl, prNumber };
}

/**
 * Update an existing PR's title and body.
 *
 * Runs `gh pr edit` with the given PR number, title, and body.
 * Throws on failure (callers handle the error).
 *
 * @param prNumber - Numeric PR identifier to update
 * @param title - New PR title
 * @param body - New PR body/description
 * @param cwd - Working directory for the gh process
 */
function updateExistingPr(
  prNumber: number,
  title: string,
  body: string,
  cwd: string,
): void {
  runGh(
    ["pr", "edit", String(prNumber), "--title", title, "--body", body],
    cwd,
  );
}

/**
 * Build a success result envelope with PR details and state patch.
 *
 * Centralizes the success-path construction so both the "created" and
 * "updated" branches in the public API use the same structure. Logs
 * the operation summary at info level.
 *
 * @param prUrl - URL of the created or updated pull request
 * @param prNumber - Numeric PR identifier
 * @param action - Whether the PR was created or updated
 * @param branchName - Branch name for the summary message
 * @returns Complete result envelope with outputs and state patch
 */
function buildSuccessResult(
  prUrl: string,
  prNumber: number,
  action: "created" | "updated",
  branchName: string,
): UpsertDraftPrResult {
  const verb = action === "created" ? "Created" : "Updated";
  const summary = `${verb} draft PR #${prNumber} on branch ${branchName}`;
  logger.info(summary, { prNumber, prUrl, branchName });

  return {
    summary,
    outputs: { prUrl, prNumber, action },
    state_patch: {
      prUrl,
      prNumber,
      prAction: action,
      deliveryStatus: { pr: "completed" },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create or update a GitHub draft pull request for a task branch.
 *
 * Execution flow:
 * 1. Validate required input fields (title, branchName, workspacePath)
 * 2. Validate GITHUB_TOKEN env-key presence (never reads the value)
 * 3. Query for an existing open PR on the branch (deduplication)
 * 4. If PR exists: update its title and body, return action "updated"
 * 5. If no PR: create a new draft PR, return action "created"
 * 6. Return a result envelope with PR details and delivery status
 *
 * Idempotency: calling twice for the same branch creates only one PR
 * (first call creates, subsequent calls update), satisfying the
 * "restart" rerun policy.
 *
 * Error handling follows envelope-based reporting: errors are returned
 * in the result summary rather than thrown, matching the push-branch.ts
 * and commit-with-trailers.ts patterns. All error messages are sanitized
 * to prevent token leakage.
 *
 * @param input - PR parameters including title, body, branch, workspace, and optional base branch
 * @returns Result envelope with PR details or error description
 */
export async function upsertDraftPr(
  input: UpsertDraftPrInput,
): Promise<UpsertDraftPrResult> {
  const { title, body, branchName, workspacePath, baseBranch } = input;
  const targetBase = baseBranch ?? DEFAULT_BASE_BRANCH;

  // Validate required input fields
  const validationError = validateInputs(title, branchName, workspacePath);
  if (validationError) {
    return validationError;
  }

  // Validate GITHUB_TOKEN presence before any gh operation
  const tokenError = validateGithubToken();
  if (tokenError) {
    return tokenError;
  }

  // Check for existing open PR on this branch (deduplication)
  logger.debug("Checking for existing open PR", { branchName });
  let existingPr: ExistingPr | null;
  try {
    existingPr = findExistingPr(branchName, workspacePath);
  } catch (err: unknown) {
    const rawMessage = extractErrorMessage(err);
    const safeMessage = sanitizeErrorMessage(rawMessage);
    logger.error("Failed to list existing PRs", { branchName, error: safeMessage });
    return errorResult(`Error: failed to check existing PRs for branch ${branchName}: ${safeMessage}`);
  }

  // Update existing PR or create a new draft PR
  if (existingPr) {
    logger.debug("Found existing PR, updating", { prNumber: existingPr.number, branchName });
    try {
      updateExistingPr(existingPr.number, title, body, workspacePath);
    } catch (err: unknown) {
      const rawMessage = extractErrorMessage(err);
      const safeMessage = sanitizeErrorMessage(rawMessage);
      logger.error("Failed to update PR", { prNumber: existingPr.number, error: safeMessage });
      return errorResult(`Error: failed to update PR #${existingPr.number}: ${safeMessage}`);
    }

    return buildSuccessResult(existingPr.url, existingPr.number, "updated", branchName);
  }

  // No existing PR found -- create a new draft PR
  logger.debug("No existing PR found, creating new draft", { branchName, baseBranch: targetBase });
  let prUrl: string;
  let prNumber: number;
  try {
    const created = createDraftPr(title, body, branchName, targetBase, workspacePath);
    prUrl = created.prUrl;
    prNumber = created.prNumber;
  } catch (err: unknown) {
    const rawMessage = extractErrorMessage(err);
    const safeMessage = sanitizeErrorMessage(rawMessage);
    logger.error("Failed to create draft PR", { branchName, error: safeMessage });
    return errorResult(`Error: failed to create draft PR for branch ${branchName}: ${safeMessage}`);
  }

  return buildSuccessResult(prUrl, prNumber, "created", branchName);
}
