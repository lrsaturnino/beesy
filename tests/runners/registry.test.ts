import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Import module under test (does not exist yet -- expected to fail in RED phase)
import {
  resolveAgentBackend,
  registerBackend,
  resetRegistry,
} from "../../src/runners/registry.js";

import type { AgentBackend, AgentConfig, StepContext, StepOutput } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create a valid AgentConfig with sensible defaults and optional overrides. */
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "anthropic/claude-sonnet-4-20250514",
    tools: ["read"],
    timeoutMs: 60000,
    ...overrides,
  };
}

/** Create a valid StepContext with sensible defaults. */
function makeStepContext(): StepContext {
  return {
    taskId: "task-001",
    taskPayload: { description: "test task" },
    gateId: "test-gate",
    stepId: "step-001",
    priorOutputs: {},
  };
}

/** Create a valid StepOutput with sensible defaults and optional overrides. */
function makeStepOutput(overrides: Partial<StepOutput> = {}): StepOutput {
  return {
    output: "stub output",
    outputFiles: [],
    ...overrides,
  };
}

/** Create a stub AgentBackend satisfying the interface with vi.fn() for run(). */
function makeStubBackend(name: string): AgentBackend {
  return {
    name,
    run: vi.fn().mockResolvedValue(makeStepOutput()),
  };
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  // Reset registry to default state before each test to prevent leakage
  resetRegistry();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Explicit Backend Resolution
// ---------------------------------------------------------------
describe("explicit backend resolution", () => {
  it("resolves cli-claude when backend is explicitly 'cli-claude'", () => {
    const config = makeAgentConfig({ backend: "cli-claude" });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-claude");
  });

  it("resolves cli-codex when backend is explicitly 'cli-codex'", () => {
    const config = makeAgentConfig({ backend: "cli-codex" });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-codex");
  });

  it("resolves cli-gemini when backend is explicitly 'cli-gemini'", () => {
    const config = makeAgentConfig({ backend: "cli-gemini" });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-gemini");
  });

  it("throws descriptive error for unknown explicit backend name", () => {
    const config = makeAgentConfig({ backend: "nonexistent-backend" });
    expect(() => resolveAgentBackend(config)).toThrowError(/nonexistent-backend/);
  });
});

// ---------------------------------------------------------------
// Group 2: Auto-Inference from Model Prefix
// ---------------------------------------------------------------
describe("auto-inference from model prefix", () => {
  it("infers cli-claude from anthropic/* model prefix", () => {
    const config = makeAgentConfig({
      model: "anthropic/claude-sonnet-4-20250514",
    });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-claude");
  });

  it("infers cli-codex from openai/* model prefix", () => {
    const config = makeAgentConfig({ model: "openai/o3-mini" });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-codex");
  });

  it("infers cli-gemini from google/* model prefix", () => {
    const config = makeAgentConfig({ model: "google/gemini-2.5-pro" });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-gemini");
  });

  it("throws descriptive error for unknown model prefix", () => {
    const config = makeAgentConfig({ model: "meta/llama-3" });
    expect(() => resolveAgentBackend(config)).toThrowError(/meta/);
  });

  it("throws descriptive error for model without provider prefix", () => {
    const config = makeAgentConfig({ model: "gpt-4o" });
    expect(() => resolveAgentBackend(config)).toThrowError();
  });
});

// ---------------------------------------------------------------
// Group 3: Explicit Backend Takes Precedence Over Model Prefix
// ---------------------------------------------------------------
describe("explicit backend takes precedence", () => {
  it("explicit backend overrides model prefix inference", () => {
    const config = makeAgentConfig({
      model: "anthropic/claude-sonnet-4-20250514",
      backend: "cli-codex",
    });
    const backend = resolveAgentBackend(config);
    expect(backend.name).toBe("cli-codex");
  });
});

// ---------------------------------------------------------------
// Group 4: Registry Management
// ---------------------------------------------------------------
describe("registry management", () => {
  it("registerBackend adds a new backend to the registry", () => {
    const customBackend = makeStubBackend("custom-sdk");
    registerBackend("custom-sdk", customBackend);

    const config = makeAgentConfig({ backend: "custom-sdk" });
    const resolved = resolveAgentBackend(config);
    expect(resolved.name).toBe("custom-sdk");
  });

  it("registerBackend overwrites existing backend with same name", () => {
    const replacement = makeStubBackend("cli-claude");
    registerBackend("cli-claude", replacement);

    const config = makeAgentConfig({ backend: "cli-claude" });
    const resolved = resolveAgentBackend(config);
    // Should return the replacement, not the original
    expect(resolved).toBe(replacement);
  });
});
