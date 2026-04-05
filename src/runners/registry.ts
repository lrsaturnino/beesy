/**
 * Agent backend registry with name-based lookup and model prefix inference.
 *
 * Maps backend names (cli-claude, cli-codex, cli-gemini) to {@link AgentBackend}
 * implementations. Supports explicit backend selection via `config.backend`
 * or automatic inference from the model provider prefix (e.g., `anthropic/*`
 * resolves to `cli-claude`). The registry is extensible -- new backends can
 * be registered at runtime via {@link registerBackend}.
 *
 * Resolution precedence:
 * 1. Explicit `config.backend` name (direct lookup)
 * 2. Provider prefix extracted from `config.model` (inference)
 *
 * @module runners/registry
 */

import type { AgentBackend, AgentConfig, StepContext, StepOutput } from "./types.js";

/**
 * Maps model provider prefixes to their default backend names.
 *
 * When no explicit backend is specified in the agent config, the provider
 * segment before the first `/` in the model identifier is used to select
 * the default backend (e.g., `"anthropic/claude-sonnet-4-20250514"` yields
 * prefix `"anthropic"` which maps to `"cli-claude"`).
 */
const MODEL_PREFIX_MAP: Readonly<Record<string, string>> = {
  anthropic: "cli-claude",
  openai: "cli-codex",
  google: "cli-gemini",
} as const;

/** Internal registry mapping backend names to implementations. */
const registry: Map<string, AgentBackend> = new Map();

/**
 * Create a stub backend that throws on execution.
 *
 * Actual CLI backend implementations are provided by separate modules;
 * these stubs satisfy the {@link AgentBackend} interface for registration
 * and resolution testing. Calling `run()` on a stub produces a descriptive
 * error so accidental invocations fail loudly.
 *
 * @param backendName - Identifier for the stub backend
 * @returns An AgentBackend whose `run()` always throws
 */
function createStubBackend(backendName: string): AgentBackend {
  return {
    name: backendName,
    run(_config: AgentConfig, _context: StepContext): Promise<StepOutput> {
      throw new Error(
        `Backend "${backendName}" is a stub -- actual implementation not loaded`,
      );
    },
  };
}

/** Populate the registry with the three default CLI backends (stubs). */
function loadDefaults(): void {
  registry.set("cli-claude", createStubBackend("cli-claude"));
  registry.set("cli-codex", createStubBackend("cli-codex"));
  registry.set("cli-gemini", createStubBackend("cli-gemini"));
}

// Initialize defaults on module load
loadDefaults();

/**
 * Register or replace an agent backend in the registry.
 *
 * Use this to swap stub backends with real implementations at startup or
 * to add custom SDK-based backends for providers not covered by the
 * default CLI adapters.
 *
 * @param name    - Unique backend identifier (e.g., `"cli-claude"`, `"custom-sdk"`)
 * @param backend - {@link AgentBackend} implementation to register
 */
export function registerBackend(name: string, backend: AgentBackend): void {
  registry.set(name, backend);
}

/**
 * Reset the registry to its default state (three CLI stubs).
 *
 * Clears all registered backends and re-registers the default stubs.
 * Intended for test isolation so registry mutations do not leak between
 * test cases.
 */
export function resetRegistry(): void {
  registry.clear();
  loadDefaults();
}

/**
 * Infer a backend name from the model provider prefix.
 *
 * Extracts the segment before the first `/` in the model identifier and
 * looks it up in {@link MODEL_PREFIX_MAP}. Throws descriptive errors when
 * the model string is malformed or the prefix is unrecognized.
 *
 * @param model - Full model identifier (e.g., `"anthropic/claude-sonnet-4-20250514"`)
 * @returns The inferred backend name (e.g., `"cli-claude"`)
 * @throws Error if the model string has no `/` separator
 * @throws Error if the provider prefix has no mapping in MODEL_PREFIX_MAP
 */
function inferBackendName(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Model identifier "${model}" is missing a provider prefix (expected "provider/model-name" format)`,
    );
  }

  const prefix = model.slice(0, slashIndex);
  const backendName = MODEL_PREFIX_MAP[prefix];
  if (!backendName) {
    const knownPrefixes = Object.keys(MODEL_PREFIX_MAP).join(", ");
    throw new Error(
      `Unknown model provider prefix "${prefix}" in model "${model}". Known prefixes: ${knownPrefixes}`,
    );
  }

  return backendName;
}

/**
 * Resolve an {@link AgentBackend} from the given agent configuration.
 *
 * Resolution order:
 * 1. If `config.backend` is set, look up by explicit name.
 * 2. Otherwise, infer the backend from the model provider prefix
 *    (the segment before the first `/` in `config.model`).
 *
 * @param config - Agent configuration containing model and optional backend name
 * @returns The resolved AgentBackend implementation
 * @throws Error if the explicit backend name is not registered
 * @throws Error if the model string lacks a provider prefix (no `/` separator)
 * @throws Error if the model provider prefix has no registered mapping
 */
export function resolveAgentBackend(config: AgentConfig): AgentBackend {
  const name = config.backend ?? inferBackendName(config.model);

  const backend = registry.get(name);
  if (!backend) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown backend "${name}". Available backends: ${available}`,
    );
  }

  return backend;
}
