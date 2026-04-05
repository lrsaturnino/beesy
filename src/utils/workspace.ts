/**
 * Workspace manager for per-task git worktree isolation.
 *
 * Creates isolated git worktrees for task execution, configures the bees-bot
 * identity, and handles cleanup after task completion. Branch naming follows
 * the convention: <prefix><task-id>-<slugified-title>.
 *
 * @module utils/workspace
 */

import { execSync } from "node:child_process";
import { createLogger } from "./logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Maximum length for the slugified portion of a branch name. */
const MAX_SLUG_LENGTH = 50;

/** Default branch name prefix for task branches. */
const DEFAULT_BRANCH_PREFIX = "bees/";

/** Default git identity name for worktree commits. */
const DEFAULT_GIT_NAME = "bees-bot";

/** Default git identity email for worktree commits. */
const DEFAULT_GIT_EMAIL = "bees@t-labs.dev";

/** Timeout for individual git subprocess calls (milliseconds). */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Extract a human-readable message from an unknown error value.
 * Handles both Error instances and arbitrary thrown values.
 */
function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a git command with standard options for workspace operations.
 * All git subprocess calls route through this function to ensure consistent
 * timeout, stdio, and encoding settings.
 *
 * @param args - Git arguments (e.g., ["worktree", "add", path])
 * @param cwd  - Working directory for the git process
 * @returns Trimmed stdout from the git command
 */
function runGit(args: string[], cwd?: string): string {
  const command = `git ${args.join(" ")}`;
  return execSync(command, {
    cwd,
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    encoding: "utf-8",
  }).trim();
}

/** Options for creating a new workspace (git worktree). */
export interface WorkspaceOptions {
  /** Path to the base git repository. */
  repoPath: string;
  /** Filesystem path where the worktree will be created. */
  worktreePath: string;
  /** Task identifier used in the branch name. */
  taskId: string;
  /** Task title, slugified for use in the branch name. */
  title: string;
  /** Branch to create the worktree from (defaults to "main"). */
  baseBranch?: string;
  /** Branch name prefix (defaults to "bees/"). */
  branchPrefix?: string;
  /** Git identity to configure in the worktree. */
  gitIdentity?: {
    name: string;
    email: string;
  };
}

/** Result of a workspace creation operation. */
export interface WorkspaceResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Absolute path to the created worktree (set on success). */
  workspacePath?: string;
  /** Full branch name created (set on success). */
  branchName?: string;
  /** Error description (set on failure). */
  error?: string;
}

/** Options for cleaning up a workspace (removing a git worktree). */
export interface CleanupOptions {
  /** Path to the base git repository. */
  repoPath: string;
  /** Worktree path to remove. */
  worktreePath: string;
  /** Whether to also delete the branch after removing the worktree. */
  deleteBranch?: boolean;
  /** Branch name to delete (required when deleteBranch is true). */
  branchName?: string;
}

/** Result of a workspace cleanup operation. */
export interface CleanupResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Error description (set on failure). */
  error?: string;
}

/**
 * Convert a task title into a URL/branch-safe slug.
 *
 * Applies lowercase, strips non-alphanumeric characters (except hyphens),
 * collapses consecutive hyphens, trims edges, and truncates to 50 characters.
 */
export function slugifyTitle(title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-$/, "");
  }

  return slug;
}

/**
 * Build the full branch name from a task ID and title.
 * Format: <prefix><taskId>-<slugified-title>
 *
 * @param taskId - Task identifier (e.g., "task-001")
 * @param title  - Human-readable task title to slugify
 * @param prefix - Branch namespace prefix (defaults to "bees/")
 * @returns Fully qualified branch name
 */
function buildBranchName(
  taskId: string,
  title: string,
  prefix?: string,
): string {
  const branchPrefix = prefix ?? DEFAULT_BRANCH_PREFIX;
  const slug = slugifyTitle(title);
  return `${branchPrefix}${taskId}-${slug}`;
}

/**
 * Create an isolated git worktree for a task.
 *
 * Checks git availability, creates a new worktree from the base branch,
 * and configures the git identity for the worktree. Returns a result object
 * with the workspace path and branch name on success, or an error on failure.
 */
export async function createWorkspace(
  options: WorkspaceOptions,
): Promise<WorkspaceResult> {
  const {
    repoPath,
    worktreePath,
    taskId,
    title,
    baseBranch = "main",
    branchPrefix,
    gitIdentity,
  } = options;

  const gitName = gitIdentity?.name ?? DEFAULT_GIT_NAME;
  const gitEmail = gitIdentity?.email ?? DEFAULT_GIT_EMAIL;

  // Verify git is available before attempting any operations
  try {
    runGit(["--version"]);
  } catch (err) {
    const message = extractErrorMessage(err);
    logger.error("git is not available", { error: message });
    return { success: false, error: `git is not available: ${message}` };
  }

  const branchName = buildBranchName(taskId, title, branchPrefix);

  // Create the worktree with a new branch from the base branch
  try {
    runGit(
      ["-C", `"${repoPath}"`, "worktree", "add", `"${worktreePath}"`, "-b", `"${branchName}"`, `"${baseBranch}"`],
    );
  } catch (err) {
    const message = extractErrorMessage(err);
    logger.error("Failed to create worktree", {
      repoPath,
      worktreePath,
      branchName,
      error: message,
    });
    return { success: false, error: message };
  }

  // Configure git identity in the worktree
  try {
    runGit(["-C", `"${worktreePath}"`, "config", "user.name", `"${gitName}"`]);
    runGit(["-C", `"${worktreePath}"`, "config", "user.email", `"${gitEmail}"`]);
  } catch (err) {
    const message = extractErrorMessage(err);
    logger.error("Failed to configure git identity", {
      worktreePath,
      error: message,
    });
    return { success: false, error: message };
  }

  logger.info("Workspace created", { worktreePath, branchName });
  return { success: true, workspacePath: worktreePath, branchName };
}

/**
 * Remove a git worktree and optionally delete its branch.
 *
 * Handles non-existent worktrees gracefully by returning success. When
 * deleteBranch is true, the branch is force-deleted after worktree removal.
 */
export async function cleanupWorkspace(
  options: CleanupOptions,
): Promise<CleanupResult> {
  const { repoPath, worktreePath, deleteBranch = false, branchName } = options;

  // Remove the worktree (non-existent worktree is not an error)
  try {
    runGit(["-C", `"${repoPath}"`, "worktree", "remove", "--force", `"${worktreePath}"`]);
  } catch (err) {
    const message = extractErrorMessage(err);
    logger.warn("Worktree removal returned an error (may already be gone)", {
      worktreePath,
      error: message,
    });
  }

  // Delete the branch if requested
  if (deleteBranch && branchName) {
    try {
      runGit(["-C", `"${repoPath}"`, "branch", "-D", `"${branchName}"`]);
      logger.info("Branch deleted", { branchName });
    } catch (err) {
      const message = extractErrorMessage(err);
      logger.error("Failed to delete branch", { branchName, error: message });
      return { success: false, error: message };
    }
  }

  logger.info("Workspace cleaned up", { worktreePath });
  return { success: true };
}
