import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------
// Mock dynamic import for controlled module loading
// ---------------------------------------------------------------

const { mockImport } = vi.hoisted(() => ({
  mockImport: vi.fn(),
}));

// Import module under test
import { runTool } from "../../src/executor/tool-runner.js";
import type { StepContext, StepOutput } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create a valid StepContext with sensible defaults and optional overrides. */
function makeStepContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    taskId: "task-001",
    taskPayload: { description: "test task" },
    gateId: "test-gate",
    stepId: "step-001",
    priorOutputs: {},
    ...overrides,
  };
}

/** Create a valid StepOutput with sensible defaults and optional overrides. */
function makeStepOutput(overrides: Partial<StepOutput> = {}): StepOutput {
  return {
    output: "tool output",
    outputFiles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Module Import and Function Call
// ---------------------------------------------------------------
describe("module import and function call", () => {
  it("dynamically imports module and calls exported function", async () => {
    const expectedOutput = makeStepOutput({ output: "tool result" });
    const toolFn = vi.fn().mockResolvedValue(expectedOutput);

    // Use a real inline module via data URI for ESM dynamic import
    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(toolFn).toHaveBeenCalledOnce();
    expect(result.output).toBe("tool result");
  });

  it("passes context to the tool function", async () => {
    const toolFn = vi.fn().mockResolvedValue(makeStepOutput());
    const context = makeStepContext({ taskId: "task-ctx-check", gateId: "gate-ctx" });

    await runTool(
      "test-module",
      "execute",
      undefined,
      context,
      { importFn: async () => ({ execute: toolFn }) },
    );

    const callArgs = toolFn.mock.calls[0];
    // Context should be passed to the function
    expect(JSON.stringify(callArgs)).toContain("task-ctx-check");
    expect(JSON.stringify(callArgs)).toContain("gate-ctx");
  });

  it("passes args to the tool function when provided", async () => {
    const toolFn = vi.fn().mockResolvedValue(makeStepOutput());
    const args = { branch: "feature/test", force: true };

    await runTool(
      "test-module",
      "execute",
      args,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    const callArgs = toolFn.mock.calls[0];
    expect(JSON.stringify(callArgs)).toContain("feature/test");
  });

  it("handles undefined args gracefully", async () => {
    const toolFn = vi.fn().mockResolvedValue(makeStepOutput());

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(toolFn).toHaveBeenCalledOnce();
    expect(result.output).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 2: Error Translation
// ---------------------------------------------------------------
describe("error translation", () => {
  it("catches thrown error and translates to failed StepOutput", async () => {
    const toolFn = vi.fn().mockRejectedValue(new Error("tool broke"));

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(result.error).toContain("tool broke");
    expect(result.output).toBe("");
  });

  it("catches non-Error throws and translates to failed StepOutput", async () => {
    const toolFn = vi.fn().mockRejectedValue("string error thrown");

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("translates module-not-found to failed StepOutput", async () => {
    const result = await runTool(
      "/nonexistent/module/path.js",
      "execute",
      undefined,
      makeStepContext(),
      {
        importFn: async () => {
          throw new Error("Cannot find module '/nonexistent/module/path.js'");
        },
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error!).toContain("nonexistent");
  });

  it("translates missing function export to failed StepOutput", async () => {
    // Module exists but does not export the requested function
    const result = await runTool(
      "test-module",
      "missingFunction",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ differentExport: vi.fn() }) },
    );

    expect(result.error).toBeDefined();
    expect(result.error!).toContain("missingFunction");
  });
});

// ---------------------------------------------------------------
// Group 3: Timeout Enforcement
// ---------------------------------------------------------------
describe("timeout enforcement", () => {
  it("enforces timeout via Promise.race", async () => {
    // Function that never resolves
    const toolFn = vi.fn().mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }), timeoutMs: 500 },
    );

    expect(result.error).toBeDefined();
    expect(result.error!.toLowerCase()).toContain("timeout");
  }, 10_000);

  it("returns proper StepOutput on timeout", async () => {
    const toolFn = vi.fn().mockImplementation(
      () => new Promise(() => {}),
    );

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }), timeoutMs: 500 },
    );

    expect(result.output).toBe("");
    expect(result.outputFiles).toEqual([]);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  }, 10_000);
});

// ---------------------------------------------------------------
// Group 4: Return Value Handling
// ---------------------------------------------------------------
describe("return value handling", () => {
  it("returns StepOutput directly when tool returns valid structure", async () => {
    const expectedOutput = makeStepOutput({
      output: "done",
      outputFiles: ["result.md"],
    });
    const toolFn = vi.fn().mockResolvedValue(expectedOutput);

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(result.output).toBe("done");
    expect(result.outputFiles).toEqual(["result.md"]);
  });

  it("wraps string return value into StepOutput", async () => {
    const toolFn = vi.fn().mockResolvedValue("plain string result");

    const result = await runTool(
      "test-module",
      "execute",
      undefined,
      makeStepContext(),
      { importFn: async () => ({ execute: toolFn }) },
    );

    expect(result.output).toBe("plain string result");
    expect(result.outputFiles).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Group 5: Uniform StepOutput
// ---------------------------------------------------------------
describe("uniform StepOutput structure", () => {
  it("always returns StepOutput with required fields", async () => {
    // Success case
    const successFn = vi.fn().mockResolvedValue(makeStepOutput({ output: "ok" }));
    const successResult = await runTool(
      "m", "f", undefined, makeStepContext(),
      { importFn: async () => ({ f: successFn }) },
    );
    expect(typeof successResult.output).toBe("string");
    expect(Array.isArray(successResult.outputFiles)).toBe(true);

    // Error case
    const errorFn = vi.fn().mockRejectedValue(new Error("fail"));
    const errorResult = await runTool(
      "m", "f", undefined, makeStepContext(),
      { importFn: async () => ({ f: errorFn }) },
    );
    expect(typeof errorResult.output).toBe("string");
    expect(Array.isArray(errorResult.outputFiles)).toBe(true);

    // Module not found case
    const notFoundResult = await runTool(
      "m", "f", undefined, makeStepContext(),
      { importFn: async () => { throw new Error("not found"); } },
    );
    expect(typeof notFoundResult.output).toBe("string");
    expect(Array.isArray(notFoundResult.outputFiles)).toBe(true);

    // Missing export case
    const missingResult = await runTool(
      "m", "missing", undefined, makeStepContext(),
      { importFn: async () => ({ other: vi.fn() }) },
    );
    expect(typeof missingResult.output).toBe("string");
    expect(Array.isArray(missingResult.outputFiles)).toBe(true);
  });
});
