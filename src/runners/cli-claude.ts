/**
 * Claude CLI agent backend adapter.
 *
 * Maps gate YAML configuration fields to Claude CLI flags and composes
 * with the shared {@link CLIAgentBackend} for subprocess lifecycle management.
 *
 * Flag mapping:
 * - model       -> `--model <stripped-id>`
 * - effort      -> `--effort <level>` (omitted when undefined)
 * - permissions -> `--dangerously-skip-permissions` (only for "full-access")
 * - outputFormat -> `--output-format <format>` (defaults to "text")
 * - prompt      -> `-p <prompt-file-content-path>`
 *
 * Output is captured from stdout.
 *
 * @module runners/cli-claude
 */

import type { AgentConfig } from "./types.js";
import { CLIAgentBackend, stripProviderPrefix, type CLIAdapter } from "./cli-backend.js";

/** Permission level that enables the dangerous skip-permissions flag. */
const FULL_ACCESS = "full-access";

/** Default output format when the config does not specify one. */
const DEFAULT_OUTPUT_FORMAT = "text";

/** Adapter that builds Claude CLI arguments from agent configuration. */
const claudeAdapter: CLIAdapter = {
  cliCommand: "claude",

  buildArgs(config: AgentConfig, promptFilePath: string): string[] {
    const args: string[] = [
      "--model", stripProviderPrefix(config.model),
    ];

    if (config.effort) {
      args.push("--effort", config.effort);
    }

    if (config.permissions === FULL_ACCESS) {
      args.push("--dangerously-skip-permissions");
    }

    args.push("--output-format", config.outputFormat ?? DEFAULT_OUTPUT_FORMAT);
    args.push("-p", promptFilePath);

    return args;
  },

  captureMode: "stdout",
};

/**
 * Claude CLI backend implementation.
 *
 * Wraps the shared CLI subprocess infrastructure with Claude-specific
 * argument construction. Instantiate via `new ClaudeCLIBackend()` and
 * register with the backend registry to replace the default stub.
 */
export class ClaudeCLIBackend extends CLIAgentBackend {
  constructor() {
    super("cli-claude", claudeAdapter);
  }
}
