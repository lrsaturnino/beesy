import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------
// Mock the registry module so dispatcher tests are isolated
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

// Import module under test (does not exist yet -- expected to fail in RED phase)
import { runSubtask } from "../../src/executor/subtask-dispatcher.js";
import type { RunnerDeps } from "../../src/executor/subtask-dispatcher.js";

import type {
  StepContext,
  StepOutput,
  AgentBackend,
  AgentConfig,
} from "../../src/runners/types.js";
import type { Subtask } from "../../src/queue/types.js";
import type { StepDefinition } from "../../src/gates/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create a valid Subtask with sensible defaults and optional overrides. */
function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: "subtask-001",
    stepId: "step-001",
    name: "Test Step",
    executionType: "agent",
    status: "pending",
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
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
    output: "test output",
    outputFiles: [],
    ...overrides,
  };
}

/** Create a StepDefinition with agent execution type. */
function makeAgentStep(
  configOverrides: Partial<AgentConfig> = {},
): StepDefinition {
  return {
    execution: {
      type: "agent",
      config: {
        model: "anthropic/claude-sonnet-4-20250514",
        tools: ["read", "write"],
        timeoutMs: 60000,
        ...configOverrides,
      },
    },
  };
}

/** Create a StepDefinition with script execution type. */
function makeScriptStep(overrides: {
  command?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
} = {}): StepDefinition {
  return {
    execution: {
      type: "script",
      command: overrides.command ?? "node scripts/validate.js",
      env: overrides.env,
      timeoutMs: overrides.timeoutMs ?? 30000,
    },
  };
}

/** Create a StepDefinition with tool execution type. */
function makeToolStep(overrides: {
  module?: string;
  function?: string;
  args?: Record<string, unknown>;
} = {}): StepDefinition {
  return {
    execution: {
      type: "tool",
      module: overrides.module ?? "src/tools/git-ops",
      function: overrides.function ?? "createBranch",
      args: overrides.args,
    },
  };
}

/** Create injected runner dependencies with mock functions. */
function makeRunnerDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    runScript: vi.fn().mockResolvedValue(makeStepOutput({ output: "script output" })),
    runTool: vi.fn().mockResolvedValue(makeStepOutput({ output: "tool output" })),
    ...overrides,
  };
}

/** Create a stub AgentBackend with vi.fn() for run(). */
function makeStubBackend(name: string, output?: StepOutput): AgentBackend {
  return {
    name,
    run: vi.fn().mockResolvedValue(output ?? makeStepOutput({ output: "agent output" })),
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
// Group 1: Agent Step Routing
// ---------------------------------------------------------------
describe("agent step routing", () => {
  it("dispatches agent-type step to backend resolved from registry", async () => {
    const backend = makeStubBackend("cli-claude");
    mockResolveAgentBackend.mockReturnValue(backend);

    const subtask = makeSubtask();
    const step = makeAgentStep();
    const context = makeStepContext();
    const runners = makeRunnerDeps();

    await runSubtask(subtask, step, context, runners);

    expect(mockResolveAgentBackend).toHaveBeenCalledOnce();
    expect(backend.run).toHaveBeenCalledOnce();
  });

  it("passes agent config from step execution to backend.run()", async () => {
    const backend = makeStubBackend("cli-claude");
    mockResolveAgentBackend.mockReturnValue(backend);

    const step = makeAgentStep({
      model: "anthropic/claude-sonnet-4-20250514",
      tools: ["read", "write", "bash"],
      timeoutMs: 120000,
      backend: "cli-claude",
    });
    const context = makeStepContext();
    const runners = makeRunnerDeps();

    await runSubtask(makeSubtask(), step, context, runners);

    const [passedConfig, passedContext] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(passedConfig.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(passedConfig.tools).toEqual(["read", "write", "bash"]);
    expect(passedConfig.timeoutMs).toBe(120000);
    expect(passedContext).toBe(context);
  });

  it("returns StepOutput from agent backend execution", async () => {
    const expectedOutput = makeStepOutput({
      output: "agent result",
      outputFiles: ["plan.md"],
    });
    const backend = makeStubBackend("cli-claude", expectedOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    const result = await runSubtask(
      makeSubtask(),
      makeAgentStep(),
      makeStepContext(),
      makeRunnerDeps(),
    );

    expect(result).toBe(expectedOutput);
  });
});

// ---------------------------------------------------------------
// Group 2: Script Step Routing
// ---------------------------------------------------------------
describe("script step routing", () => {
  it("dispatches script-type step to injected script runner", async () => {
    const runners = makeRunnerDeps();
    const step = makeScriptStep({ command: "node script.js" });

    await runSubtask(makeSubtask({ executionType: "script" }), step, makeStepContext(), runners);

    expect(runners.runScript).toHaveBeenCalledOnce();
  });

  it("passes command and env from step execution to script runner", async () => {
    const runners = makeRunnerDeps();
    const env = { API_KEY: "test", NODE_ENV: "test" };
    const step = makeScriptStep({ command: "python3 run.py", env });
    const context = makeStepContext();

    await runSubtask(makeSubtask({ executionType: "script" }), step, context, runners);

    expect(runners.runScript).toHaveBeenCalledWith("python3 run.py", env, context);
  });

  it("returns StepOutput from script runner execution", async () => {
    const expectedOutput = makeStepOutput({ output: "script ran successfully" });
    const runners = makeRunnerDeps({
      runScript: vi.fn().mockResolvedValue(expectedOutput),
    });
    const step = makeScriptStep();

    const result = await runSubtask(
      makeSubtask({ executionType: "script" }),
      step,
      makeStepContext(),
      runners,
    );

    expect(result).toBe(expectedOutput);
  });
});

// ---------------------------------------------------------------
// Group 3: Tool Step Routing
// ---------------------------------------------------------------
describe("tool step routing", () => {
  it("dispatches tool-type step to injected tool runner", async () => {
    const runners = makeRunnerDeps();
    const step = makeToolStep({
      module: "src/tools/git-ops",
      function: "createBranch",
    });

    await runSubtask(makeSubtask({ executionType: "tool" }), step, makeStepContext(), runners);

    expect(runners.runTool).toHaveBeenCalledOnce();
  });

  it("passes module, function, and args from step execution to tool runner", async () => {
    const runners = makeRunnerDeps();
    const args = { branch: "feature/test" };
    const step = makeToolStep({
      module: "src/tools/git-ops",
      function: "createBranch",
      args,
    });
    const context = makeStepContext();

    await runSubtask(makeSubtask({ executionType: "tool" }), step, context, runners);

    expect(runners.runTool).toHaveBeenCalledWith(
      "src/tools/git-ops",
      "createBranch",
      args,
      context,
    );
  });

  it("returns StepOutput from tool runner execution", async () => {
    const expectedOutput = makeStepOutput({ output: "branch created" });
    const runners = makeRunnerDeps({
      runTool: vi.fn().mockResolvedValue(expectedOutput),
    });
    const step = makeToolStep();

    const result = await runSubtask(
      makeSubtask({ executionType: "tool" }),
      step,
      makeStepContext(),
      runners,
    );

    expect(result).toBe(expectedOutput);
  });
});

// ---------------------------------------------------------------
// Group 4: Uniform StepOutput
// ---------------------------------------------------------------
describe("uniform StepOutput", () => {
  it("all runner types produce StepOutput with output and outputFiles fields", async () => {
    // Agent
    const agentOutput = makeStepOutput({ output: "agent", outputFiles: ["a.md"] });
    const backend = makeStubBackend("cli-claude", agentOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    const agentResult = await runSubtask(
      makeSubtask({ executionType: "agent" }),
      makeAgentStep(),
      makeStepContext(),
      makeRunnerDeps(),
    );
    expect(agentResult).toHaveProperty("output");
    expect(agentResult).toHaveProperty("outputFiles");
    expect(typeof agentResult.output).toBe("string");
    expect(Array.isArray(agentResult.outputFiles)).toBe(true);

    // Script
    const scriptOutput = makeStepOutput({ output: "script", outputFiles: ["b.md"] });
    const scriptRunners = makeRunnerDeps({
      runScript: vi.fn().mockResolvedValue(scriptOutput),
    });

    const scriptResult = await runSubtask(
      makeSubtask({ executionType: "script" }),
      makeScriptStep(),
      makeStepContext(),
      scriptRunners,
    );
    expect(scriptResult).toHaveProperty("output");
    expect(scriptResult).toHaveProperty("outputFiles");
    expect(typeof scriptResult.output).toBe("string");
    expect(Array.isArray(scriptResult.outputFiles)).toBe(true);

    // Tool
    const toolOutput = makeStepOutput({ output: "tool", outputFiles: ["c.md"] });
    const toolRunners = makeRunnerDeps({
      runTool: vi.fn().mockResolvedValue(toolOutput),
    });

    const toolResult = await runSubtask(
      makeSubtask({ executionType: "tool" }),
      makeToolStep(),
      makeStepContext(),
      toolRunners,
    );
    expect(toolResult).toHaveProperty("output");
    expect(toolResult).toHaveProperty("outputFiles");
    expect(typeof toolResult.output).toBe("string");
    expect(Array.isArray(toolResult.outputFiles)).toBe(true);
  });

  it("StepOutput optional fields (cost, error, exitCode) are preserved when present", async () => {
    const fullOutput = makeStepOutput({
      output: "done",
      outputFiles: ["result.md"],
      cost: { totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0.01 },
      error: "partial failure",
      exitCode: 1,
    });
    const backend = makeStubBackend("cli-claude", fullOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    const result = await runSubtask(
      makeSubtask(),
      makeAgentStep(),
      makeStepContext(),
      makeRunnerDeps(),
    );

    expect(result.cost).toBeDefined();
    expect(result.cost!.totalTokens).toBe(100);
    expect(result.error).toBe("partial failure");
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------
// Group 5: Error Handling
// ---------------------------------------------------------------
describe("error handling", () => {
  it("propagates error from agent backend.run() as rejection", async () => {
    const backend = makeStubBackend("cli-claude");
    (backend.run as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("backend execution failed"),
    );
    mockResolveAgentBackend.mockReturnValue(backend);

    await expect(
      runSubtask(makeSubtask(), makeAgentStep(), makeStepContext(), makeRunnerDeps()),
    ).rejects.toThrow("backend execution failed");
  });

  it("propagates error from script runner as rejection", async () => {
    const runners = makeRunnerDeps({
      runScript: vi.fn().mockRejectedValue(new Error("script crashed")),
    });

    await expect(
      runSubtask(
        makeSubtask({ executionType: "script" }),
        makeScriptStep(),
        makeStepContext(),
        runners,
      ),
    ).rejects.toThrow("script crashed");
  });

  it("propagates error from tool runner as rejection", async () => {
    const runners = makeRunnerDeps({
      runTool: vi.fn().mockRejectedValue(new Error("tool failed")),
    });

    await expect(
      runSubtask(
        makeSubtask({ executionType: "tool" }),
        makeToolStep(),
        makeStepContext(),
        runners,
      ),
    ).rejects.toThrow("tool failed");
  });
});
