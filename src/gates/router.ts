/**
 * Gate router: discovers gate YAML files at startup, builds an in-memory
 * command lookup map, and matches incoming messages to gate configurations.
 *
 * The router consumes the gate loader to parse and validate YAML files,
 * filters out disabled gates, and creates Task objects ready for queue
 * submission when a command matches.
 *
 * @module gates/router
 */

import { randomUUID } from "node:crypto";
import { loadGates } from "./loader.js";
import type { GateConfig } from "./types.js";
import type { Task, CostAccumulator } from "../queue/types.js";
import type { NormalizedMessage } from "../adapters/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Router instance returned by {@link initRouter}.
 *
 * Provides synchronous command matching and task creation against the
 * pre-loaded set of enabled gate configurations.
 */
export interface GateRouter {
  /**
   * Look up a gate configuration by slash command string.
   *
   * @param command - Slash command to look up (e.g., "/new-implementation")
   * @returns The matching GateConfig, or null if no gate handles this command
   */
  match(command: string): GateConfig | null;

  /**
   * Create a Task from a NormalizedMessage by matching its command to a gate.
   *
   * Returns null when no gate matches the command. When a gate matches,
   * constructs a complete Task with status "queued", priority "normal",
   * and zero-initialized cost.
   *
   * @param message - Normalized input from an adapter
   * @returns A fully populated Task ready for queue submission, or null
   */
  createTask(message: NormalizedMessage): Task | null;
}

/** Zero-value cost accumulator for newly created tasks. */
const ZERO_COST: CostAccumulator = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
};

/**
 * Build a command-to-config lookup map from loaded gate configurations.
 *
 * Filters out disabled gates (where gate.enabled is explicitly false).
 * Gates without an explicit enabled field default to enabled.
 *
 * @param configs - Gate configurations returned by the loader
 * @returns Map keyed by slash command string to its GateConfig
 */
function buildCommandMap(configs: GateConfig[]): Map<string, GateConfig> {
  const commandMap = new Map<string, GateConfig>();
  for (const config of configs) {
    if (config.gate.enabled !== false) {
      commandMap.set(config.gate.command, config);
    }
  }
  return commandMap;
}

/**
 * Construct a Task object from a matched gate configuration and message.
 *
 * Sets initial task state: status "queued", priority "normal", position 0,
 * and a zero-initialized cost accumulator. The task ID is a random UUID.
 *
 * @param config  - The gate configuration that matched the command
 * @param message - The normalized input from an adapter
 * @returns A fully populated Task ready for queue submission
 */
function buildTask(config: GateConfig, message: NormalizedMessage): Task {
  return {
    id: randomUUID(),
    gate: config.gate.id,
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
 * Initialize the gate router by loading and validating all gate YAML files
 * from the given directory.
 *
 * Calls the gate loader to parse every .yaml/.yml file, checks for validation
 * errors (hard stop), logs warnings, filters out disabled gates, and builds
 * the command lookup map.
 *
 * @param gatesDir - Absolute path to the directory containing gate YAML files
 * @returns An initialized GateRouter with match and createTask methods
 * @throws {Error} When any gate file has validation errors -- all errors are
 *   aggregated into a single message so the operator can fix them in one pass
 */
export async function initRouter(gatesDir: string): Promise<GateRouter> {
  const result = await loadGates(gatesDir);

  if (result.errors.length > 0) {
    const details = result.errors
      .map((e) => `[${e.file}] ${e.message}`)
      .join("; ");
    throw new Error(`Gate validation failed: ${details}`);
  }

  for (const warning of result.warnings) {
    logger.warn(warning.message, { file: warning.file });
  }

  const commandMap = buildCommandMap(result.configs);

  logger.info(`Gate router initialized with ${commandMap.size} active gate(s)`, {
    activeGates: commandMap.size,
    totalLoaded: result.configs.length,
    warnings: result.warnings.length,
  });

  function match(command: string): GateConfig | null {
    return commandMap.get(command) ?? null;
  }

  function createTask(message: NormalizedMessage): Task | null {
    const config = match(message.command);
    if (!config) {
      return null;
    }
    return buildTask(config, message);
  }

  return { match, createTask };
}
