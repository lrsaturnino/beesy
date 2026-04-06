/**
 * Recipe YAML configuration loader with stage-graph validation.
 *
 * Discovers recipe.yaml files from subdirectories of a given directory,
 * parses them using the yaml library, validates the resulting stage graph
 * and required fields, and returns a Map of recipe ID to validated
 * RecipeConfig objects.
 *
 * Validation is exhaustive: all errors are collected in a single pass so
 * that users can fix everything at once rather than chasing one error at
 * a time. Cycle detection defaults to rejecting cycles unless the recipe
 * opts in with `cycle_policy: allow`.
 *
 * @module recipes/loader
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  RecipeConfig,
  OrchestratorConfig,
  StageDefinition,
  StageInput,
  StageOutput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A validation message produced during recipe loading or validation.
 *
 * Mirrors the `ValidationMessage` interface from the gate loader so that
 * consumers can handle both message types uniformly.
 */
export interface ValidationMessage {
  /** Whether this is a fatal error or a non-fatal warning. */
  severity: "error" | "warning";
  /** The file that produced this message. */
  file: string;
  /** Human-readable description of the issue. */
  message: string;
}

// ---------------------------------------------------------------------------
// Shared validation helpers
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
 * Create a validation error message bound to a specific file.
 *
 * @param filePath - Source file the error originates from.
 * @param message - Human-readable description of the violation.
 * @returns A `ValidationMessage` with severity "error".
 */
function validationError(filePath: string, message: string): ValidationMessage {
  return { severity: "error", file: filePath, message };
}

/**
 * Create a validation warning message bound to a specific file.
 *
 * @param filePath - Source file the warning originates from.
 * @param message - Human-readable description of the concern.
 * @returns A `ValidationMessage` with severity "warning".
 */
function validationWarning(filePath: string, message: string): ValidationMessage {
  return { severity: "warning", file: filePath, message };
}

// ---------------------------------------------------------------------------
// Recipe metadata validation
// ---------------------------------------------------------------------------

/**
 * Validate the recipe metadata section (id, name, command, description).
 *
 * The recipe section wraps identity and routing fields. The command field
 * must begin with `/` so it can function as a slash command trigger.
 *
 * @param recipe - The parsed `recipe:` YAML section, or undefined if absent.
 * @param filePath - Source file path for error message context.
 * @returns Validation messages for any missing or invalid metadata fields.
 */
function validateRecipeMetadata(
  recipe: Record<string, unknown> | undefined,
  filePath: string,
): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  if (!recipe || typeof recipe !== "object") {
    msgs.push(validationError(filePath, "recipe section is missing or not an object"));
    return msgs;
  }

  if (!isNonEmptyString(recipe.id)) {
    msgs.push(validationError(filePath, "recipe.id is missing or empty"));
  }

  if (!isNonEmptyString(recipe.name)) {
    msgs.push(validationError(filePath, "recipe.name is missing or empty"));
  }

  if (!recipe.command) {
    msgs.push(validationError(filePath, "recipe.command is missing"));
  } else if (typeof recipe.command === "string" && !recipe.command.startsWith("/")) {
    msgs.push(validationError(filePath, `recipe.command "${recipe.command}" must start with /`));
  }

  if (!isNonEmptyString(recipe.description)) {
    msgs.push(validationError(filePath, "recipe.description is missing or empty"));
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// Orchestrator validation
// ---------------------------------------------------------------------------

/**
 * Validate the orchestrator configuration section.
 *
 * Checks for the four required fields: role, backend, model, and
 * timeout_ms. Additional optional fields (effort, max_stage_retries,
 * max_total_actions) are accepted without validation.
 *
 * @param orchestrator - The parsed `orchestrator:` YAML section.
 * @param filePath - Source file path for error message context.
 * @returns Validation messages for any missing or invalid orchestrator fields.
 */
function validateOrchestratorConfig(
  orchestrator: unknown,
  filePath: string,
): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  if (!orchestrator || typeof orchestrator !== "object") {
    msgs.push(validationError(filePath, "orchestrator section is missing or not an object"));
    return msgs;
  }

  const orch = orchestrator as Record<string, unknown>;

  if (!isNonEmptyString(orch.role)) {
    msgs.push(validationError(filePath, "orchestrator.role is missing or empty"));
  }

  if (!isNonEmptyString(orch.backend)) {
    msgs.push(validationError(filePath, "orchestrator.backend is missing or empty"));
  }

  if (!isNonEmptyString(orch.model)) {
    msgs.push(validationError(filePath, "orchestrator.model is missing or empty"));
  }

  if (typeof orch.timeout_ms !== "number") {
    msgs.push(validationError(filePath, "orchestrator.timeout_ms is missing or not a number"));
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// Per-stage field validation
// ---------------------------------------------------------------------------

/**
 * Validate required fields on each stage definition.
 *
 * Every stage must have a non-empty `role` (path to the agent role file)
 * and a non-empty `objective` (what the stage agent should accomplish).
 *
 * @param stages - The parsed `stages:` YAML section as a string-keyed record.
 * @param filePath - Source file path for error message context.
 * @returns Validation messages for stages with missing required fields.
 */
function validateStageFields(
  stages: Record<string, unknown>,
  filePath: string,
): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  for (const [stageId, stageDef] of Object.entries(stages)) {
    if (!stageDef || typeof stageDef !== "object") {
      msgs.push(validationError(filePath, `stages.${stageId} is not a valid object`));
      continue;
    }

    const stage = stageDef as Record<string, unknown>;

    if (!isNonEmptyString(stage.role)) {
      msgs.push(validationError(filePath, `stages.${stageId}.role is missing or empty`));
    }

    if (!isNonEmptyString(stage.objective)) {
      msgs.push(validationError(filePath, `stages.${stageId}.objective is missing or empty`));
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// Stage graph topology validation
// ---------------------------------------------------------------------------

/**
 * Validate stage graph topology constraints.
 *
 * Enforces five invariants that downstream components (decision validator,
 * orchestrator loop) rely on:
 *   1. `start_stage` references an existing stage.
 *   2. Every `stage_order` entry references an existing stage.
 *   3. No orphan stages (every stage key must appear in `stage_order`).
 *   4. No duplicate entries in `stage_order`.
 *   5. Every `allowed_transitions` target references an existing stage.
 *
 * @param stageOrder - The parsed `stage_order:` array.
 * @param startStage - The parsed `start_stage:` value.
 * @param stages - The parsed `stages:` YAML section.
 * @param filePath - Source file path for error message context.
 * @returns Validation messages for any topology violations.
 */
function validateStageGraphTopology(
  stageOrder: unknown,
  startStage: unknown,
  stages: Record<string, unknown>,
  filePath: string,
): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  if (!Array.isArray(stageOrder) || stageOrder.length === 0) {
    msgs.push(validationError(filePath, "stage_order is missing or empty"));
    return msgs;
  }

  if (!startStage || typeof startStage !== "string") {
    msgs.push(validationError(filePath, "start_stage is missing or not a string"));
    return msgs;
  }

  const stageIds = new Set(Object.keys(stages));
  const orderSet = new Set<string>();

  // Duplicate entries in stage_order
  for (const entry of stageOrder) {
    if (typeof entry !== "string") continue;
    if (orderSet.has(entry)) {
      msgs.push(validationError(filePath, `duplicate stage ID "${entry}" in stage_order`));
    }
    orderSet.add(entry);
  }

  // start_stage must reference an existing stage
  if (!stageIds.has(startStage)) {
    msgs.push(
      validationError(filePath, `start_stage "${startStage}" does not exist in stages`),
    );
  }

  // Every stage_order entry must reference an existing stage
  for (const entry of stageOrder) {
    if (typeof entry === "string" && !stageIds.has(entry)) {
      msgs.push(
        validationError(filePath, `stage_order entry "${entry}" does not exist in stages`),
      );
    }
  }

  // No orphan stages (stage keys not listed in stage_order)
  for (const stageId of stageIds) {
    if (!orderSet.has(stageId)) {
      msgs.push(
        validationError(filePath, `stage "${stageId}" is not in stage_order (orphan stage)`),
      );
    }
  }

  // All allowed_transitions targets must reference existing stages
  for (const [stageId, stageDef] of Object.entries(stages)) {
    if (!stageDef || typeof stageDef !== "object") continue;
    const transitions = (stageDef as Record<string, unknown>).allowed_transitions;
    if (!Array.isArray(transitions)) continue;

    for (const target of transitions) {
      if (typeof target === "string" && !stageIds.has(target)) {
        msgs.push(
          validationError(
            filePath,
            `stages.${stageId}.allowed_transitions references "${target}" which does not exist in stages`,
          ),
        );
      }
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/** DFS node coloring for cycle detection. */
const enum DfsColor {
  /** Node has not been visited yet. */
  White = 0,
  /** Node is currently on the DFS stack (ancestor in the current path). */
  Gray = 1,
  /** Node and all its descendants have been fully explored. */
  Black = 2,
}

/**
 * Detect cycles in the stage transition graph using DFS with three-color
 * marking. Encountering a gray (in-progress) node from a gray ancestor
 * proves a back-edge exists, which means a cycle.
 *
 * @param stages - The parsed `stages:` section keyed by stage ID.
 * @returns `true` when at least one cycle exists in the transition graph.
 */
function hasCycles(stages: Record<string, unknown>): boolean {
  const colors = new Map<string, DfsColor>();

  for (const stageId of Object.keys(stages)) {
    colors.set(stageId, DfsColor.White);
  }

  function dfs(node: string): boolean {
    colors.set(node, DfsColor.Gray);

    const stageDef = stages[node];
    if (stageDef && typeof stageDef === "object") {
      const transitions = (stageDef as Record<string, unknown>).allowed_transitions;
      if (Array.isArray(transitions)) {
        for (const neighbor of transitions) {
          if (typeof neighbor !== "string") continue;
          const color = colors.get(neighbor);
          if (color === DfsColor.Gray) return true;
          if (color === DfsColor.White && dfs(neighbor)) return true;
        }
      }
    }

    colors.set(node, DfsColor.Black);
    return false;
  }

  for (const stageId of Object.keys(stages)) {
    if (colors.get(stageId) === DfsColor.White) {
      if (dfs(stageId)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// RecipeConfig construction
// ---------------------------------------------------------------------------

/**
 * Safely coerce a YAML value to a readonly array, defaulting to an empty
 * array when the value is missing or not an array.
 *
 * @param value - The raw YAML value to coerce.
 * @returns The value cast as a readonly array, or an empty readonly array.
 */
function toReadonlyArray<T>(value: unknown): readonly T[] {
  return (Array.isArray(value) ? value : []) as readonly T[];
}

/**
 * Build a typed `StageDefinition` from a raw YAML stage object.
 *
 * Uses safe coercion for array fields so that missing or non-array values
 * produce empty arrays rather than crashing at runtime.
 *
 * @param raw - The raw stage object parsed from YAML.
 * @returns A fully typed `StageDefinition`.
 */
function buildStageDefinition(raw: Record<string, unknown>): StageDefinition {
  return {
    role: raw.role as string,
    objective: raw.objective as string,
    inputs: toReadonlyArray<StageInput>(raw.inputs),
    outputs: toReadonlyArray<StageOutput>(raw.outputs),
    allowed_transitions: toReadonlyArray<string>(raw.allowed_transitions),
    allowed_scripts: toReadonlyArray<string>(raw.allowed_scripts),
  };
}

/**
 * Construct a validated `RecipeConfig` from a parsed YAML object.
 *
 * Assumes the raw object has already passed validation via
 * {@link validateRecipe}. Maps YAML top-level sections to RecipeConfig
 * fields without key transformation (recipe types already use snake_case
 * matching the YAML schema).
 *
 * @param raw - The validated parsed YAML record.
 * @returns A fully typed `RecipeConfig` ready for downstream consumption.
 */
function buildRecipeConfig(raw: Record<string, unknown>): RecipeConfig {
  const recipe = raw.recipe as Record<string, unknown>;
  const orchestrator = raw.orchestrator as OrchestratorConfig;
  const stages = raw.stages as Record<string, Record<string, unknown>>;

  const builtStages: Record<string, StageDefinition> = {};
  for (const [stageId, stageDef] of Object.entries(stages)) {
    builtStages[stageId] = buildStageDefinition(stageDef);
  }

  return {
    id: recipe.id as string,
    name: recipe.name as string,
    command: recipe.command as string,
    description: recipe.description as string,
    orchestrator,
    stage_order: raw.stage_order as readonly string[],
    start_stage: raw.start_stage as string,
    stages: builtStages,
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * List subdirectory names from a given directory path.
 *
 * Returns an empty array when the directory does not exist (ENOENT),
 * allowing callers to treat a missing recipes directory as having zero
 * recipes rather than as an error.
 *
 * @param dir - Absolute or relative directory path to scan.
 * @returns Sorted array of subdirectory names found within `dir`.
 * @throws When the directory cannot be read for reasons other than ENOENT.
 */
async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exhaustively validate a parsed recipe YAML object against the RecipeConfig
 * schema and stage-graph topology rules.
 *
 * Collects all errors and warnings without short-circuiting so that users
 * can fix every issue in a single pass. Each message includes the file path
 * for context.
 *
 * Validation proceeds in phases:
 *   1. Recipe metadata (id, name, command, description)
 *   2. Orchestrator required fields (role, backend, model, timeout_ms)
 *   3. Per-stage required fields (role, objective)
 *   4. Stage graph topology (start_stage, stage_order, orphans, transitions)
 *   5. Cycle detection with configurable policy (default: reject)
 *
 * @param raw - The parsed YAML object (output of `yaml.parse`).
 * @param filePath - Source file path included in every validation message.
 * @returns Array of validation messages (errors and/or warnings).
 */
export function validateRecipe(
  raw: unknown,
  filePath: string,
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  if (!raw || typeof raw !== "object") {
    messages.push(validationError(filePath, "Recipe content is not a valid object"));
    return messages;
  }

  const parsed = raw as Record<string, unknown>;
  const recipe = parsed.recipe as Record<string, unknown> | undefined;
  const orchestrator = parsed.orchestrator;
  const stageOrder = parsed.stage_order;
  const startStage = parsed.start_stage;
  const stages = parsed.stages as Record<string, unknown> | undefined;
  const cyclePolicy = parsed.cycle_policy as string | undefined;

  // Phase 1: Recipe metadata
  messages.push(...validateRecipeMetadata(recipe, filePath));

  // Phase 2: Orchestrator configuration
  messages.push(...validateOrchestratorConfig(orchestrator, filePath));

  // Stages section must exist before graph-level checks can proceed
  if (!stages || typeof stages !== "object") {
    messages.push(validationError(filePath, "stages section is missing or not an object"));
    return messages;
  }

  // Phase 3: Per-stage required fields
  messages.push(...validateStageFields(stages, filePath));

  // Phase 4: Stage graph topology
  messages.push(...validateStageGraphTopology(stageOrder, startStage, stages, filePath));

  // Phase 5: Cycle detection (default policy: reject)
  if (hasCycles(stages)) {
    if (cyclePolicy === "allow") {
      messages.push(
        validationWarning(filePath, "Transition cycle detected in stage graph (allowed by cycle_policy)"),
      );
    } else {
      messages.push(
        validationError(
          filePath,
          "Transition cycle detected in stage graph -- set cycle_policy: allow to permit cycles",
        ),
      );
    }
  }

  return messages;
}

/**
 * Discover, parse, and validate all recipe YAML files from subdirectories
 * of the given directory. Each subdirectory should contain a `recipe.yaml`
 * file following the convention: `recipes/<recipe-id>/recipe.yaml`.
 *
 * Subdirectories that lack a `recipe.yaml` file are silently skipped.
 * When the directory itself does not exist, an empty Map is returned
 * rather than throwing.
 *
 * @param dir - Path to the directory containing recipe subdirectories.
 * @returns Map of recipe ID to validated RecipeConfig.
 * @throws When a `recipe.yaml` file contains invalid YAML syntax.
 * @throws When a recipe fails validation (error messages list all violations).
 */
export async function loadRecipes(
  dir: string,
): Promise<Map<string, RecipeConfig>> {
  const result = new Map<string, RecipeConfig>();
  const subdirs = await listSubdirectories(dir);

  for (const subdir of subdirs) {
    const recipeFilePath = path.join(dir, subdir, "recipe.yaml");

    let content: string;
    try {
      content = await readFile(recipeFilePath, "utf-8");
    } catch {
      // Subdirectory does not contain recipe.yaml -- skip silently
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`YAML parse error in ${recipeFilePath}: ${detail}`);
    }

    const validationMessages = validateRecipe(parsed, recipeFilePath);
    const errors = validationMessages.filter((m) => m.severity === "error");

    if (errors.length > 0) {
      const details = errors.map((e) => e.message).join("; ");
      throw new Error(`Validation errors in ${recipeFilePath}: ${details}`);
    }

    const config = buildRecipeConfig(parsed as Record<string, unknown>);
    result.set(config.id, config);
  }

  return result;
}
