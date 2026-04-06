/**
 * Recipe router: matches incoming slash commands to validated recipe
 * configurations and creates tasks ready for the recipe-driven worker.
 *
 * Receives a pre-loaded Map of recipes from the recipe loader (no
 * filesystem I/O), builds a command-to-config lookup map, and validates
 * that no two recipes claim the same command. Exposes a collision
 * detection function that compares recipe commands against an existing
 * gate router to identify overlap at startup.
 *
 * @module recipes/router
 */

import { randomUUID } from "node:crypto";
import type { RecipeConfig } from "./types.js";
import type { Task, CostAccumulator } from "../queue/types.js";
import type { NormalizedMessage } from "../adapters/types.js";
import type { GateRouter } from "../gates/router.js";

/**
 * Router instance returned by {@link initRecipeRouter}.
 *
 * Provides synchronous command matching, task creation, and command
 * enumeration against the pre-loaded set of recipe configurations.
 */
export interface RecipeRouter {
  /**
   * Look up a recipe configuration by slash command string.
   *
   * @param command - Slash command to look up (e.g., "/new-implementation")
   * @returns The matching RecipeConfig, or null if no recipe handles this command
   */
  match(command: string): RecipeConfig | null;

  /**
   * Create a Task from a NormalizedMessage by matching its command to a recipe.
   *
   * Returns null when no recipe matches the command. When a recipe matches,
   * constructs a complete Task with status "queued", priority "normal",
   * recipeId set, and zero-initialized cost.
   *
   * @param message - Normalized input from an adapter
   * @returns A fully populated Task ready for queue submission, or null
   */
  createTask(message: NormalizedMessage): Task | null;

  /**
   * Return the set of all slash commands claimed by loaded recipes.
   *
   * Used by collision detection and gate filtering to identify which
   * commands the recipe router handles.
   *
   * @returns Set of command strings (e.g., {"/new-implementation", "/deploy"})
   */
  getCommands(): Set<string>;
}

/** Zero-value cost accumulator for newly created tasks. */
const ZERO_COST: CostAccumulator = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
};

/**
 * Build a command-to-config lookup map from loaded recipe configurations.
 *
 * Validates that no two recipes claim the same slash command. Duplicate
 * commands within the recipe set are a hard startup error because
 * ambiguous routing would silently drop one recipe's traffic.
 *
 * @param recipes - Map of recipe ID to RecipeConfig from the loader
 * @returns Map keyed by slash command string to its RecipeConfig
 * @throws {Error} When two recipes claim the same command
 */
function buildCommandMap(
  recipes: Map<string, RecipeConfig>,
): Map<string, RecipeConfig> {
  const commandMap = new Map<string, RecipeConfig>();

  for (const [, config] of recipes) {
    const existing = commandMap.get(config.command);
    if (existing) {
      throw new Error(
        `Duplicate recipe command "${config.command}" claimed by both ` +
          `recipe "${existing.id}" and recipe "${config.id}"`,
      );
    }
    commandMap.set(config.command, config);
  }

  return commandMap;
}

/**
 * Construct a Task object from a matched recipe configuration and message.
 *
 * Sets initial task state: status "queued", priority "normal", position 0,
 * recipeId set to the recipe identifier, and a zero-initialized cost
 * accumulator. The task ID is a random UUID. The gate field is set to the
 * recipe id for compatibility with existing queue infrastructure.
 *
 * @param config  - The recipe configuration that matched the command
 * @param message - The normalized input from an adapter
 * @returns A fully populated Task ready for queue submission
 */
function buildTask(config: RecipeConfig, message: NormalizedMessage): Task {
  return {
    id: randomUUID(),
    gate: config.id,
    recipeId: config.id,
    status: "queued",
    priority: "normal",
    position: 0,
    payload: message.payload,
    requestedBy: message.requestedBy,
    sourceChannel: message.channel,
    createdAt: new Date(),
    cost: { ...ZERO_COST },
  };
}

/**
 * Initialize the recipe router from a pre-loaded and validated recipe map.
 *
 * Synchronous initialization (no filesystem I/O) since the recipe loader
 * handles all parsing and validation upstream. Builds the command lookup
 * map and validates no duplicate commands exist.
 *
 * @param recipes - Map of recipe ID to validated RecipeConfig from loadRecipes
 * @returns An initialized RecipeRouter with match, createTask, and getCommands methods
 * @throws {Error} When two recipes claim the same slash command
 */
export function initRecipeRouter(
  recipes: Map<string, RecipeConfig>,
): RecipeRouter {
  const commandMap = buildCommandMap(recipes);

  function match(command: string): RecipeConfig | null {
    return commandMap.get(command) ?? null;
  }

  function createTask(message: NormalizedMessage): Task | null {
    const config = match(message.command);
    if (!config) {
      return null;
    }
    return buildTask(config, message);
  }

  function getCommands(): Set<string> {
    return new Set(commandMap.keys());
  }

  return { match, createTask, getCommands };
}

/**
 * Detect command collisions between the recipe router and gate router.
 *
 * Iterates all recipe-claimed commands and checks whether the gate router
 * also matches each one. For each collision, logs a warning indicating
 * the recipe takes precedence. Returns the set of colliding commands so
 * the caller can track which gate commands are effectively disabled.
 *
 * @param recipeRouter - Initialized recipe router
 * @param gateRouter   - Initialized gate router
 * @param log          - Logger for collision warnings
 * @returns Set of command strings claimed by both a recipe and a gate
 */
export function detectCollisions(
  recipeRouter: RecipeRouter,
  gateRouter: GateRouter,
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Set<string> {
  const collisions = new Set<string>();

  for (const command of recipeRouter.getCommands()) {
    const gateMatch = gateRouter.match(command);
    if (gateMatch) {
      const recipeMatch = recipeRouter.match(command);
      const recipeId = recipeMatch?.id ?? "unknown";
      const gateId = gateMatch.gate.id;

      log.warn(
        `Command ${command} claimed by both recipe "${recipeId}" and gate "${gateId}" -- recipe takes precedence, gate disabled for this command`,
        { command, recipeId, gateId },
      );

      collisions.add(command);
    }
  }

  return collisions;
}
