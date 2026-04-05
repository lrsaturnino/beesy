/**
 * Codex CLI agent backend adapter.
 *
 * Maps gate YAML configuration fields to Codex CLI flags and composes
 * with the shared {@link CLIAgentBackend} for subprocess lifecycle management.
 *
 * Flag mapping:
 * - subcommand  -> `exec` (always present)
 * - model       -> `--model <stripped-id>`
 * - effort      -> `-c model_reasoning_effort=<level>` (omitted when undefined)
 * - permissions -> `--dangerously-bypass-approvals-and-sandbox` (only for "full-access")
 * - git check   -> `--skip-git-repo-check` (always present)
 * - output      -> `-o <output-file-path>` (file-based output capture)
 *
 * Output is captured from the `-o` file, not from stdout.
 *
 * @module runners/cli-codex
 */

import type { AgentConfig } from "./types.js";
import { CLIAgentBackend, stripProviderPrefix, type CLIAdapter } from "./cli-backend.js";

/** Permission level that enables the dangerous bypass flag. */
const FULL_ACCESS = "full-access";

/** Adapter that builds Codex CLI arguments from agent configuration. */
const codexAdapter: CLIAdapter = {
  cliCommand: "codex",

  buildArgs(config: AgentConfig, _promptFilePath: string, outputFilePath?: string): string[] {
    const args: string[] = [
      "exec",
      "--model", stripProviderPrefix(config.model),
    ];

    if (config.effort) {
      args.push("-c", `model_reasoning_effort=${config.effort}`);
    }

    args.push("--skip-git-repo-check");

    if (config.permissions === FULL_ACCESS) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    if (outputFilePath) {
      args.push("-o", outputFilePath);
    }

    return args;
  },

  captureMode: "file",
};

/**
 * Codex CLI backend implementation.
 *
 * Wraps the shared CLI subprocess infrastructure with Codex-specific
 * argument construction. Uses file-based output capture via the `-o` flag
 * instead of reading from stdout. Instantiate via `new CodexCLIBackend()`
 * and register with the backend registry to replace the default stub.
 */
export class CodexCLIBackend extends CLIAgentBackend {
  constructor() {
    super("cli-codex", codexAdapter);
  }
}
