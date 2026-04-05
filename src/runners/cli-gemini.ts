/**
 * Gemini CLI agent backend adapter.
 *
 * Maps gate YAML configuration fields to Gemini CLI flags and composes
 * with the shared {@link CLIAgentBackend} for subprocess lifecycle management.
 *
 * Flag mapping:
 * - model         -> `--model <stripped-id>`
 * - approval mode -> `--approval-mode=yolo` (always present, regardless of permissions)
 * - outputFormat  -> `--output-format <format>` (when configured)
 * - prompt        -> `-p <prompt-file-content-path>`
 * - effort        -> ignored (Gemini does not support effort configuration)
 *
 * Output is captured from stdout.
 *
 * @module runners/cli-gemini
 */

import type { AgentConfig } from "./types.js";
import { CLIAgentBackend, stripProviderPrefix, type CLIAdapter } from "./cli-backend.js";

/**
 * Gemini always runs in auto-approve mode for automated execution.
 * Unlike Claude and Codex, Gemini does not have a conditional permissions
 * flag -- `--approval-mode=yolo` is always present per the scope spec.
 */
const APPROVAL_MODE_FLAG = "--approval-mode=yolo";

/** Adapter that builds Gemini CLI arguments from agent configuration. */
const geminiAdapter: CLIAdapter = {
  cliCommand: "gemini",

  buildArgs(config: AgentConfig, promptFilePath: string): string[] {
    const args: string[] = [
      "--model", stripProviderPrefix(config.model),
      APPROVAL_MODE_FLAG,
    ];

    if (config.outputFormat) {
      args.push("--output-format", config.outputFormat);
    }

    args.push("-p", promptFilePath);

    return args;
  },

  captureMode: "stdout",
};

/**
 * Gemini CLI backend implementation.
 *
 * Wraps the shared CLI subprocess infrastructure with Gemini-specific
 * argument construction. The effort configuration is intentionally ignored
 * as Gemini does not support reasoning effort control. The `--approval-mode=yolo`
 * flag is always present regardless of the permissions setting.
 * Instantiate via `new GeminiCLIBackend()` and register with the backend
 * registry to replace the default stub.
 */
export class GeminiCLIBackend extends CLIAgentBackend {
  constructor() {
    super("cli-gemini", geminiAdapter);
  }
}
