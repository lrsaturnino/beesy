/**
 * Explicit file staging action for the delivery pipeline.
 *
 * Stages specific files via individual git add commands while enforcing
 * a hardcoded exclusion list to protect sensitive directories and files.
 * Supports glob pattern expansion via Node.js 22 built-in fs.globSync.
 *
 * Never performs broad git add (no -A or .). Each file is staged
 * individually after passing exclusion checks.
 *
 * @module delivery/stage-explicit
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for the stageExplicit action. */
export interface StageExplicitInput {
  /** File paths or glob patterns to stage. */
  readonly files: readonly string[];
  /** Absolute path to the git workspace. */
  readonly workspacePath: string;
}

/** A single excluded file entry with the reason for exclusion. */
export interface ExcludedEntry {
  /** The file path that was excluded. */
  readonly path: string;
  /** The reason the file was excluded. */
  readonly reason: string;
}

/**
 * Result returned by the stageExplicit action.
 *
 * Shape is compatible with ScriptResultEnvelope (summary + outputs) but uses
 * a domain-specific outputs structure carrying staged and excluded file lists
 * instead of ScriptOutputArtifact entries.
 *
 * @see {@link import("../scripts/types.js").ScriptResultEnvelope}
 */
export interface StageExplicitResult {
  /** Human-readable summary of the staging operation. */
  readonly summary: string;
  /** Staging outputs with lists of staged and excluded files. */
  readonly outputs: {
    readonly staged: readonly string[];
    readonly excluded: readonly ExcludedEntry[];
  };
}

// ---------------------------------------------------------------------------
// Exclusion rules
// ---------------------------------------------------------------------------

/**
 * Directory prefixes that are always excluded from staging.
 *
 * Each entry ends with `/` so that prefix matching does not produce false
 * positives on similarly-named files (e.g., `runtime-config.ts` is not
 * matched by `runtime/`).
 */
const EXCLUDED_DIR_PREFIXES = [".bees/", "runtime/", "node_modules/"] as const;

// ---------------------------------------------------------------------------
// Git constants
// ---------------------------------------------------------------------------

/** Timeout for individual git subprocess calls (milliseconds). */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Glob constants
// ---------------------------------------------------------------------------

/**
 * Regex matching glob metacharacters that indicate a pattern needs expansion.
 *
 * When a file argument contains any of these characters, it is treated as a
 * glob pattern and expanded via `fs.globSync` rather than as a literal path.
 */
const GLOB_METACHARACTERS = /[*?[\]{}]/;

// ---------------------------------------------------------------------------
// Exclusion check
// ---------------------------------------------------------------------------

/** Result of an exclusion check for a single file path. */
export interface ExclusionCheckResult {
  /** Whether the file path matches an exclusion rule. */
  readonly excluded: boolean;
  /** Human-readable reason for exclusion (present only when excluded). */
  readonly reason?: string;
}

/**
 * Check whether a workspace-relative file path matches any exclusion rule.
 *
 * Exclusion rules (applied in order, first match wins):
 * 1. Directory prefixes: `.bees/`, `runtime/`, `node_modules/` -- matched via
 *    `startsWith` or embedded `/<prefix>` to handle nested paths.
 * 2. Env file pattern: basename starts with `.env` -- matches `.env`,
 *    `.env.local`, `.env.production`, etc.
 *
 * @param filePath - Workspace-relative file path to check.
 * @returns Check result indicating whether the path is excluded and why.
 */
export function isExcludedPath(filePath: string): ExclusionCheckResult {
  const normalized = filePath.replace(/\\/g, "/");

  for (const prefix of EXCLUDED_DIR_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return { excluded: true, reason: `matches excluded directory: ${prefix}` };
    }
  }

  const basename = path.basename(normalized);
  if (basename.startsWith(".env")) {
    return { excluded: true, reason: "matches excluded pattern: .env*" };
  }

  return { excluded: false };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an unknown error value.
 */
function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expand a list of file paths and glob patterns into unique resolved paths.
 *
 * Glob patterns (containing `*`, `?`, `[`, `]`, `{`, `}`) are expanded via
 * git ls-files with the glob pattern relative to the workspace directory.
 * Literal paths are forwarded as-is for downstream existence checks.
 *
 * Duplicates are removed so that a file matched by both a literal path and
 * a glob pattern is only staged once.
 *
 * @param patterns - File paths or glob patterns to expand.
 * @param workspacePath - Workspace root for glob resolution.
 * @returns Deduplicated array of workspace-relative file paths.
 */
function expandPatterns(
  patterns: readonly string[],
  workspacePath: string,
): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];

  const addUnique = (raw: string): void => {
    const normalized = raw.replace(/\\/g, "/");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      resolved.push(normalized);
    }
  };

  for (const pattern of patterns) {
    if (GLOB_METACHARACTERS.test(pattern)) {
      try {
        const matches = execSync(`git ls-files --others --cached -- '${pattern}'`, {
          cwd: workspacePath,
          encoding: "utf-8",
        }).trim();
        if (matches) {
          for (const match of matches.split("\n")) {
            addUnique(match);
          }
        }
      } catch {
        logger.warn("Glob expansion failed, treating as literal path", { pattern });
        addUnique(pattern);
      }
    } else {
      addUnique(pattern);
    }
  }

  return resolved;
}

/**
 * Stage a single file via `git add` in the workspace.
 *
 * Replicates the `runGit` subprocess pattern from `workspace.ts`:
 * `execFileSync` with `stdio: "pipe"`, 30-second timeout, and UTF-8 encoding.
 * Uses `execFileSync` (not `execSync`) to avoid shell invocation.
 *
 * @param filePath - Workspace-relative file path to stage.
 * @param workspacePath - Workspace root directory (passed as `cwd`).
 * @throws When `git add` exits with a non-zero code or times out.
 */
function gitAddFile(filePath: string, workspacePath: string): void {
  execFileSync("git", ["add", filePath], {
    cwd: workspacePath,
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    encoding: "utf-8",
  });
}

/**
 * Process a single resolved file path for staging.
 *
 * Applies the exclusion check, verifies file existence, and attempts
 * `git add`. Returns an exclusion entry on failure, or pushes to the
 * staged array on success.
 *
 * @param filePath - Workspace-relative file path to process.
 * @param workspacePath - Workspace root directory.
 * @param staged - Accumulator array for successfully staged paths.
 * @param excluded - Accumulator array for excluded/failed entries.
 */
function processFile(
  filePath: string,
  workspacePath: string,
  staged: string[],
  excluded: ExcludedEntry[],
): void {
  const exclusionCheck = isExcludedPath(filePath);
  if (exclusionCheck.excluded) {
    excluded.push({
      path: filePath,
      reason: exclusionCheck.reason ?? "excluded by policy",
    });
    logger.debug("File excluded from staging", { filePath, reason: exclusionCheck.reason });
    return;
  }

  const absolutePath = path.join(workspacePath, filePath);
  if (!existsSync(absolutePath)) {
    excluded.push({
      path: filePath,
      reason: "file does not exist",
    });
    logger.debug("File does not exist, excluding", { filePath });
    return;
  }

  try {
    gitAddFile(filePath, workspacePath);
    staged.push(filePath);
    logger.debug("File staged", { filePath });
  } catch (err: unknown) {
    const message = extractErrorMessage(err);
    excluded.push({
      path: filePath,
      reason: `git add failed: ${message}`,
    });
    logger.warn("Failed to stage file", { filePath, error: message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage specific files in a git workspace with exclusion filtering.
 *
 * Validates input, expands glob patterns, applies exclusion rules,
 * stages each non-excluded file individually via git add, and returns
 * a result envelope with staged and excluded file lists.
 *
 * @param input - The staging input with file paths and workspace path.
 * @returns A result envelope with staged and excluded file lists.
 */
export async function stageExplicit(
  input: StageExplicitInput,
): Promise<StageExplicitResult> {
  const { files, workspacePath } = input;

  if (!workspacePath || workspacePath.trim().length === 0) {
    logger.error("stageExplicit called with empty workspacePath");
    return {
      summary: "Error: missing or empty workspacePath",
      outputs: { staged: [], excluded: [] },
    };
  }

  if (files.length === 0) {
    logger.debug("stageExplicit called with empty file list");
    return {
      summary: "No files to stage",
      outputs: { staged: [], excluded: [] },
    };
  }

  const expanded = expandPatterns(files, workspacePath);
  const staged: string[] = [];
  const excluded: ExcludedEntry[] = [];

  for (const filePath of expanded) {
    processFile(filePath, workspacePath, staged, excluded);
  }

  const summary = `Staged ${staged.length} file(s), excluded ${excluded.length} file(s)`;
  logger.info(summary, {
    staged: staged.length,
    excluded: excluded.length,
  });

  return {
    summary,
    outputs: { staged, excluded },
  };
}
