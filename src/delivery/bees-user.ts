/**
 * BeesUser identity mapping module.
 *
 * Loads user identity mappings from a YAML configuration file, resolving
 * Slack user identities to GitHub identities for commit attribution in
 * the delivery pipeline. Provides pure accessor functions for user
 * lookup and commit trailer generation.
 *
 * Validation is exhaustive: all errors are collected in a single pass so
 * that operators can fix everything at once rather than chasing one error
 * at a time.
 *
 * @module delivery/bees-user
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Identity mapping between a Slack user and their GitHub account.
 *
 * Required fields identify the user in Slack. Optional GitHub fields
 * enable commit attribution when present.
 */
export interface BeesUser {
  /** Slack user identifier (e.g., "U001"). */
  slackUserId: string;
  /** Display name shown in Slack. */
  slackDisplayName: string;
  /** GitHub login handle (optional). */
  githubLogin?: string;
  /** Full name used in git commits (optional). */
  githubName?: string;
  /** Email used in git commits (optional). */
  githubEmail?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape of a single user object as parsed from YAML before validation. */
type RawUserEntry = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a value is a non-empty string after trimming whitespace.
 *
 * @param value - The value to check.
 * @returns `true` when `value` is a string with at least one non-whitespace character.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a single user entry from the parsed YAML configuration.
 *
 * Collects all validation errors without short-circuiting so that
 * multiple issues can be reported at once.
 *
 * @param entry - A single parsed YAML user object.
 * @param index - Zero-based position of the entry in the users array.
 * @returns Array of error strings describing every validation failure.
 */
function validateUserEntry(entry: RawUserEntry, index: number): string[] {
  const errors: string[] = [];
  const label = isNonEmptyString(entry.slackUserId)
    ? String(entry.slackUserId)
    : `users[${index}]`;

  if (!isNonEmptyString(entry.slackUserId)) {
    errors.push(`${label}: slackUserId is missing or empty`);
  }

  if (!isNonEmptyString(entry.slackDisplayName)) {
    errors.push(`${label}: slackDisplayName is missing or empty`);
  }

  return errors;
}

/**
 * Build a typed {@link BeesUser} from a validated YAML entry.
 *
 * Optional GitHub fields are only set when present and non-empty,
 * ensuring they remain `undefined` when absent.
 *
 * @param entry - A validated YAML user object.
 * @returns A fully typed BeesUser ready for registry insertion.
 */
function buildBeesUser(entry: RawUserEntry): BeesUser {
  const user: BeesUser = {
    slackUserId: entry.slackUserId as string,
    slackDisplayName: entry.slackDisplayName as string,
  };

  if (isNonEmptyString(entry.githubLogin)) {
    user.githubLogin = entry.githubLogin;
  }

  if (isNonEmptyString(entry.githubName)) {
    user.githubName = entry.githubName;
  }

  if (isNonEmptyString(entry.githubEmail)) {
    user.githubEmail = entry.githubEmail;
  }

  return user;
}

// ---------------------------------------------------------------------------
// YAML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw YAML content into a JavaScript value.
 *
 * Wraps the `yaml` library's parse function to produce a domain-specific
 * error message that includes the config file path for debugging.
 *
 * @param content - Raw YAML string to parse.
 * @param configPath - File path included in the error message for context.
 * @returns The parsed JavaScript value.
 * @throws {Error} When the content is not valid YAML syntax.
 */
function parseUsersYaml(content: string, configPath: string): unknown {
  try {
    return parseYaml(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML parse error in ${configPath}: ${detail}`);
  }
}

/**
 * Extract and validate the top-level `users` array from parsed YAML.
 *
 * Ensures the parsed content is a valid object and contains a `users`
 * array. Unlike the script registry, an empty users array is accepted
 * because having no mapped users is a valid starting configuration.
 *
 * @param parsed - The parsed YAML value.
 * @param configPath - File path included in the error message for context.
 * @returns The validated users array (may be empty).
 * @throws {Error} When the top-level structure is not an object.
 * @throws {Error} When the `users` key is missing or not an array.
 */
function extractUsersArray(parsed: unknown, configPath: string): unknown[] {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Users config must be a YAML mapping in ${configPath}`,
    );
  }

  const users = (parsed as Record<string, unknown>).users;

  if (!Array.isArray(users)) {
    throw new Error(
      `Users config must contain a "users" array in ${configPath}`,
    );
  }

  return users;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, parse, and validate a bees-users YAML config file into a Map.
 *
 * Reads the YAML file, extracts the `users` array, validates each entry
 * for required fields, then builds a Map keyed by `slackUserId`.
 *
 * Validation proceeds in two layers:
 *   1. Per-entry field validation (required string fields)
 *   2. Cross-entry uniqueness validation (duplicate `slackUserId` detection)
 *
 * All errors are collected before throwing so operators can fix every
 * issue in a single pass.
 *
 * @param configPath - Path to the bees-users YAML config file.
 * @returns Map of slackUserId to validated BeesUser.
 * @throws {Error} When the config file cannot be read or contains invalid YAML.
 * @throws {Error} When any field or uniqueness validation error is found
 *   (all errors are reported in a single message, separated by `"; "`).
 */
export async function loadBeesUsers(
  configPath: string,
): Promise<Map<string, BeesUser>> {
  const content = await readFile(configPath, "utf-8");
  const parsed = parseUsersYaml(content, configPath);
  const entries = extractUsersArray(parsed, configPath);

  const errors: string[] = [];
  const registry = new Map<string, BeesUser>();
  const seenIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as RawUserEntry;

    if (!entry || typeof entry !== "object") {
      errors.push(`users[${i}]: entry is not a valid object`);
      continue;
    }

    const entryErrors = validateUserEntry(entry, i);
    errors.push(...entryErrors);

    // Detect duplicate IDs alongside per-entry validation so both
    // field errors and uniqueness errors appear in the same report
    const slackUserId = entry.slackUserId;
    if (isNonEmptyString(slackUserId)) {
      if (seenIds.has(slackUserId)) {
        errors.push(
          `Duplicate slackUserId "${slackUserId}" found in config`,
        );
      } else {
        seenIds.add(slackUserId);
      }
    }

    // Build the user only when the entry passed all validation
    if (
      entryErrors.length === 0 &&
      isNonEmptyString(slackUserId) &&
      !registry.has(slackUserId)
    ) {
      registry.set(slackUserId, buildBeesUser(entry));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Validation errors in ${configPath}: ${errors.join("; ")}`,
    );
  }

  return registry;
}

/**
 * Look up a user in the registry by their Slack user identifier.
 *
 * This is a pure function with no side effects: it performs a single
 * `Map.get` and coerces `undefined` to `null` for a consistent
 * nullable return type.
 *
 * @param users - The loaded user Map returned by {@link loadBeesUsers}.
 * @param slackUserId - The Slack user ID to look up (e.g., `"U001"`).
 * @returns The matching {@link BeesUser}, or `null` if not found.
 */
export function resolveUser(
  users: Map<string, BeesUser>,
  slackUserId: string,
): BeesUser | null {
  return users.get(slackUserId) ?? null;
}

/**
 * Generate a `Requested-by` commit trailer for a user.
 *
 * Prefers the GitHub name when available, falling back to the Slack
 * display name.
 *
 * @param user - The BeesUser to generate a trailer for.
 * @returns A formatted `Requested-by: <name>` string.
 */
export function buildRequestedByTrailer(user: BeesUser): string {
  return `Requested-by: ${user.githubName ?? user.slackDisplayName}`;
}

/**
 * Generate a `Co-authored-by` commit trailer for a user.
 *
 * Returns the trailer only when both `githubName` and `githubEmail` are
 * present, since the git convention requires both fields for the
 * `Name <email>` format. Returns `null` when either field is missing,
 * signalling to the caller that co-authorship attribution is unavailable.
 *
 * @param user - The BeesUser to generate a trailer for.
 * @returns A formatted `Co-authored-by: Name <email>` string, or `null`
 *   when the user lacks a complete GitHub identity.
 */
export function buildCoAuthoredByTrailer(user: BeesUser): string | null {
  if (user.githubName && user.githubEmail) {
    return `Co-authored-by: ${user.githubName} <${user.githubEmail}>`;
  }
  return null;
}
