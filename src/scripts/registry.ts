/**
 * Script registry loader and accessor functions.
 *
 * Loads script manifests from a YAML file, validates each entry against
 * the ScriptManifest schema (required fields, enum membership, path
 * existence), and exposes pure accessor functions that operate on the
 * resulting registry Map.
 *
 * Validation is exhaustive: all errors are collected in a single pass so
 * that users can fix everything at once rather than chasing one error at
 * a time. This mirrors the exhaustive validation approach used by the
 * recipe loader ({@link module:recipes/loader}).
 *
 * @module scripts/registry
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ScriptManifest, ScriptCatalogEntry } from "./types.js";
import { SCRIPT_RUNTIMES, SIDE_EFFECT_LEVELS, RERUN_POLICIES } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of checking whether required environment variables are present.
 *
 * The `missing` array lists variable names only; values are never read
 * or exposed to prevent accidental secret leakage.
 */
export interface EnvValidationResult {
  /** Whether all required environment variables are present. */
  valid: boolean;
  /** Names of environment variables that are not set. */
  missing: readonly string[];
}

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
 * Validate that a string field belongs to an allowed set of values.
 *
 * When the field is missing or empty, reports a "missing or empty" error.
 * When the field is present but not in the allowed set, reports the
 * invalid value alongside the allowed alternatives.
 *
 * @param value - The raw YAML field value to validate.
 * @param fieldName - The field name used in error messages.
 * @param allowedValues - The const array of valid values.
 * @param label - Human-readable entry label for error context.
 * @returns Array of error strings (empty when valid).
 */
function validateEnumField(
  value: unknown,
  fieldName: string,
  allowedValues: readonly string[],
  label: string,
): string[] {
  if (!isNonEmptyString(value)) {
    return [`${label}: ${fieldName} is missing or empty`];
  }
  if (!allowedValues.includes(value)) {
    return [
      `${label}: ${fieldName} "${value}" is not valid (expected one of: ${allowedValues.join(", ")})`,
    ];
  }
  return [];
}

/**
 * Validate that a script path exists on the filesystem.
 *
 * Paths in the manifest are relative to a workspace root. This function
 * resolves them against the provided base path and checks existence.
 *
 * @param value - The raw YAML path field value.
 * @param basePath - Workspace root for resolving relative paths.
 * @param label - Human-readable entry label for error context.
 * @returns Array of error strings (empty when valid).
 */
function validateScriptPath(
  value: unknown,
  basePath: string,
  label: string,
): string[] {
  if (!isNonEmptyString(value)) {
    return [`${label}: path is missing or empty`];
  }
  const resolvedPath = path.resolve(basePath, value);
  if (!existsSync(resolvedPath)) {
    return [
      `${label}: path "${value}" does not exist (resolved to ${resolvedPath})`,
    ];
  }
  return [];
}

/**
 * Validate a single script entry from the parsed YAML manifest.
 *
 * Delegates to focused sub-validators for enum fields and path existence.
 * Collects all validation errors without short-circuiting so that
 * multiple issues can be reported at once.
 *
 * @param entry - A single parsed YAML script object.
 * @param index - Zero-based position of the entry in the scripts array.
 * @param basePath - Workspace root for resolving relative script paths.
 * @returns Array of error strings describing every validation failure.
 */
function validateScriptEntry(
  entry: Record<string, unknown>,
  index: number,
  basePath: string,
): string[] {
  const errors: string[] = [];
  const label = isNonEmptyString(entry.script_id)
    ? entry.script_id
    : `scripts[${index}]`;

  if (!isNonEmptyString(entry.script_id)) {
    errors.push(`${label}: script_id is missing or empty`);
  }

  if (!isNonEmptyString(entry.description)) {
    errors.push(`${label}: description is missing or empty`);
  }

  errors.push(
    ...validateEnumField(
      entry.runtime,
      "runtime",
      SCRIPT_RUNTIMES as readonly string[],
      label,
    ),
  );

  errors.push(...validateScriptPath(entry.path, basePath, label));

  if (typeof entry.timeout_ms !== "number") {
    errors.push(`${label}: timeout_ms is missing or not a number`);
  }

  if (typeof entry.retryable !== "boolean") {
    errors.push(`${label}: retryable is missing or not a boolean`);
  }

  errors.push(
    ...validateEnumField(
      entry.side_effects,
      "side_effects",
      SIDE_EFFECT_LEVELS as readonly string[],
      label,
    ),
  );

  if (entry.required_env !== undefined && !Array.isArray(entry.required_env)) {
    errors.push(`${label}: required_env must be an array`);
  }

  errors.push(
    ...validateEnumField(
      entry.rerun_policy,
      "rerun_policy",
      RERUN_POLICIES as readonly string[],
      label,
    ),
  );

  return errors;
}

/**
 * Build a typed {@link ScriptManifest} from a validated YAML entry.
 *
 * Optional fields (`input_schema`, `output_schema`, `orchestrator_notes`)
 * are only set when present and non-null in the source, ensuring they
 * remain `undefined` when absent.
 *
 * @param entry - A validated YAML script object.
 * @returns A fully typed ScriptManifest ready for registry insertion.
 */
function buildScriptManifest(entry: Record<string, unknown>): ScriptManifest {
  const manifest: ScriptManifest = {
    script_id: entry.script_id as string,
    description: entry.description as string,
    runtime: entry.runtime as ScriptManifest["runtime"],
    path: entry.path as string,
    timeout_ms: entry.timeout_ms as number,
    retryable: entry.retryable as boolean,
    side_effects: entry.side_effects as ScriptManifest["side_effects"],
    required_env: Array.isArray(entry.required_env)
      ? (entry.required_env as string[])
      : [],
    rerun_policy: entry.rerun_policy as ScriptManifest["rerun_policy"],
  };

  if (entry.input_schema !== undefined && entry.input_schema !== null) {
    manifest.input_schema = entry.input_schema as Record<string, unknown>;
  }

  if (entry.output_schema !== undefined && entry.output_schema !== null) {
    manifest.output_schema = entry.output_schema as Record<string, unknown>;
  }

  if (isNonEmptyString(entry.orchestrator_notes)) {
    manifest.orchestrator_notes = entry.orchestrator_notes;
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// YAML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw YAML content into a JavaScript object.
 *
 * Wraps the `yaml` library's parse function to produce a domain-specific
 * error message that includes the manifest file path for debugging.
 *
 * @param content - Raw YAML string to parse.
 * @param manifestPath - Source file path included in the error message.
 * @returns The parsed JavaScript value.
 * @throws When the content is not valid YAML.
 */
function parseManifestYaml(content: string, manifestPath: string): unknown {
  try {
    return parseYaml(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML parse error in ${manifestPath}: ${detail}`);
  }
}

/**
 * Extract and validate the top-level `scripts` array from parsed YAML.
 *
 * Ensures the parsed content is a valid object and contains a non-empty
 * `scripts` array, which is the required structure for the manifest.
 *
 * @param parsed - The parsed YAML value.
 * @param manifestPath - Source file path included in error messages.
 * @returns The validated scripts array.
 * @throws When the content structure is invalid.
 */
function extractScriptsArray(
  parsed: unknown,
  manifestPath: string,
): unknown[] {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Manifest content is not a valid object in ${manifestPath}`,
    );
  }

  const scripts = (parsed as Record<string, unknown>).scripts;

  if (!Array.isArray(scripts) || scripts.length === 0) {
    throw new Error(
      `Manifest must contain a non-empty "scripts" array in ${manifestPath}`,
    );
  }

  return scripts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, parse, and validate a script manifest YAML file into a registry Map.
 *
 * Reads the YAML file, extracts the `scripts` array, validates each entry
 * for required fields, enum membership, and path existence, then builds a
 * Map keyed by `script_id`.
 *
 * Validation proceeds in two layers:
 *   1. Per-entry field validation (types, enums, path existence)
 *   2. Cross-entry uniqueness validation (duplicate `script_id` detection)
 *
 * All errors are collected before throwing so users can fix every issue
 * in a single pass.
 *
 * @param manifestPath - Absolute path to the manifest YAML file.
 * @param basePath - Workspace root used to resolve relative script paths.
 * @returns Map of script_id to validated ScriptManifest.
 * @throws When the manifest file cannot be read or parsed.
 * @throws When any validation error is found (all errors reported at once).
 */
export async function loadScriptRegistry(
  manifestPath: string,
  basePath: string,
): Promise<Map<string, ScriptManifest>> {
  const content = await readFile(manifestPath, "utf-8");
  const parsed = parseManifestYaml(content, manifestPath);
  const scripts = extractScriptsArray(parsed, manifestPath);

  const errors: string[] = [];
  const registry = new Map<string, ScriptManifest>();
  const seenIds = new Set<string>();

  for (let i = 0; i < scripts.length; i++) {
    const entry = scripts[i] as Record<string, unknown>;

    if (!entry || typeof entry !== "object") {
      errors.push(`scripts[${i}]: entry is not a valid object`);
      continue;
    }

    const entryErrors = validateScriptEntry(entry, i, basePath);
    errors.push(...entryErrors);

    // Detect duplicate IDs alongside per-entry validation so both
    // field errors and uniqueness errors appear in the same report
    const scriptId = entry.script_id;
    if (isNonEmptyString(scriptId)) {
      if (seenIds.has(scriptId)) {
        errors.push(`Duplicate script_id "${scriptId}" found in manifest`);
      } else {
        seenIds.add(scriptId);
      }
    }

    // Build the manifest only when the entry passed all validation
    if (
      entryErrors.length === 0 &&
      isNonEmptyString(scriptId) &&
      !registry.has(scriptId)
    ) {
      registry.set(scriptId, buildScriptManifest(entry));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Validation errors in ${manifestPath}: ${errors.join("; ")}`,
    );
  }

  return registry;
}

/**
 * Look up a script in the registry by its unique identifier.
 *
 * This is a pure function with no side effects: it performs a single
 * `Map.get` and coerces `undefined` to `null` for a consistent
 * nullable return type.
 *
 * @param registry - The loaded registry Map returned by {@link loadScriptRegistry}.
 * @param scriptId - The `script_id` to look up (e.g., `"knowledge.prime"`).
 * @returns The matching {@link ScriptManifest}, or `null` if not found.
 */
export function resolveScript(
  registry: Map<string, ScriptManifest>,
  scriptId: string,
): ScriptManifest | null {
  return registry.get(scriptId) ?? null;
}

/**
 * Project the full registry into an array of orchestrator-visible catalog
 * entries.
 *
 * Each {@link ScriptCatalogEntry} contains only the fields the orchestrator
 * needs for dispatch decisions. Implementation-private fields (`path`,
 * `required_env`, `input_schema`, `output_schema`, `rerun_policy`) are
 * excluded by constructing new objects with explicit field selection
 * rather than spreading and deleting.
 *
 * @param registry - The loaded registry Map returned by {@link loadScriptRegistry}.
 * @returns Array of {@link ScriptCatalogEntry} objects.
 */
export function buildCatalogSummary(
  registry: Map<string, ScriptManifest>,
): ScriptCatalogEntry[] {
  const catalog: ScriptCatalogEntry[] = [];

  for (const manifest of registry.values()) {
    const entry: ScriptCatalogEntry = {
      script_id: manifest.script_id,
      description: manifest.description,
      runtime: manifest.runtime,
      side_effects: manifest.side_effects,
      timeout_ms: manifest.timeout_ms,
      retryable: manifest.retryable,
    };

    if (manifest.orchestrator_notes !== undefined) {
      entry.orchestrator_notes = manifest.orchestrator_notes;
    }

    catalog.push(entry);
  }

  return catalog;
}

/**
 * Check whether all required environment variables for a script are present.
 *
 * Uses `key in process.env` for presence checking; the actual values are
 * **never** read, accessed, or included in the result to prevent
 * accidental secret leakage into logs or error messages.
 *
 * @param registry - The loaded registry Map returned by {@link loadScriptRegistry}.
 * @param scriptId - The `script_id` to check environment requirements for.
 * @returns An {@link EnvValidationResult} when the script exists, or `null`
 *   when the script_id is not found in the registry.
 */
export function validateEnvRequirements(
  registry: Map<string, ScriptManifest>,
  scriptId: string,
): EnvValidationResult | null {
  const manifest = registry.get(scriptId);
  if (!manifest) {
    return null;
  }

  const missing = manifest.required_env.filter(
    (envVar) => !(envVar in process.env),
  );

  return {
    valid: missing.length === 0,
    missing,
  };
}
