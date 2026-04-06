import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { executeTask } from "../../src/executor/task-executor.js";
import { buildStepContext } from "../../src/executor/context-builder.js";
import { createStderrBatcher } from "../../src/utils/stderr-batcher.js";
import { interpolateEnvVars } from "../../src/gates/loader.js";

import type { ProgressEvent } from "../../src/executor/task-executor.js";
import type { Task, Subtask, CostAccumulator } from "../../src/queue/types.js";
import type {
  GateConfig,
  StepDefinition,
  GateMetadata,
  GateInput,
  GateWorkflow,
} from "../../src/gates/types.js";
import type { StepContext, StepOutput } from "../../src/runners/types.js";
import type { Adapter } from "../../src/adapters/adapter.js";

// ---------------------------------------------------------------
// Self-contained fixture factories
// ---------------------------------------------------------------

/** Create a zero-initialized CostAccumulator. */
function makeCostAccumulator(): CostAccumulator {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** Create a valid Task with sensible defaults and optional overrides. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-reg-001",
    gate: "test-gate",
    status: "queued",
    priority: "normal",
    position: 0,
    payload: { repo: "test-repo", branch: "main" },
    requestedBy: "user-001",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-05T00:00:00Z"),
    cost: makeCostAccumulator(),
    ...overrides,
  };
}

/** Create a GateConfig with configurable workflow steps and step definitions. */
function makeGateConfig(
  stepConfigs: Record<
    string,
    {
      type: "agent" | "script" | "tool";
      behavior?: string;
      retryPolicy?: { maxRetries: number };
    }
  > = {
    "step-analyze": { type: "agent", behavior: "Analyze the codebase" },
    "step-implement": {
      type: "script",
      behavior: "Run implementation script",
    },
    "step-validate": { type: "tool", behavior: "Validate output" },
  },
): GateConfig {
  const stepIds = Object.keys(stepConfigs);

  const steps: Record<string, StepDefinition> = {};
  for (const [stepId, config] of Object.entries(stepConfigs)) {
    if (config.type === "agent") {
      steps[stepId] = {
        execution: {
          type: "agent",
          config: {
            model: "anthropic/claude-sonnet-4-20250514",
            tools: ["read", "write"],
            timeoutMs: 60000,
          },
        },
        behavior: config.behavior,
        ...(config.retryPolicy && { retryPolicy: config.retryPolicy }),
      };
    } else if (config.type === "script") {
      steps[stepId] = {
        execution: {
          type: "script",
          command: "node scripts/run.js",
          timeoutMs: 30000,
        },
        behavior: config.behavior,
        ...(config.retryPolicy && { retryPolicy: config.retryPolicy }),
      };
    } else {
      steps[stepId] = {
        execution: {
          type: "tool",
          module: "src/tools/validate",
          function: "validate",
        },
        behavior: config.behavior,
        ...(config.retryPolicy && { retryPolicy: config.retryPolicy }),
      };
    }
  }

  const gate: GateMetadata = {
    id: "test-gate",
    name: "Test Gate",
    command: "/test",
    description: "A test gate for regression tests",
  };

  const input: GateInput = {
    required: [{ description: "Repository URL" }],
  };

  const workflow: GateWorkflow = {
    steps: stepIds,
  };

  return { gate, input, workflow, steps };
}

/** Create a valid StepOutput with sensible defaults and optional overrides. */
function makeStepOutput(overrides: Partial<StepOutput> = {}): StepOutput {
  return {
    output: "step completed successfully",
    outputFiles: [],
    ...overrides,
  };
}

/** Create a mock dispatch function that returns a default StepOutput. */
function makeDispatch() {
  return vi
    .fn<[Subtask, StepDefinition, StepContext], Promise<StepOutput>>()
    .mockResolvedValue(makeStepOutput());
}

/** Create a mock Adapter with a configurable createThread return value. */
function makeAdapter(
  threadTs: string = "thread.1234",
): Adapter {
  return {
    name: "mock-adapter",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendReply: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue(threadTs),
  };
}

// ---------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Behavior 1: Context Passing (priorOutputs accumulation)
// ---------------------------------------------------------------
describe("context passing (priorOutputs accumulation)", () => {
  it("first step receives empty priorOutputs", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });

    const context = buildStepContext(task, gateConfig, "step-one");

    expect(context.priorOutputs).toEqual({});
  });

  it("subsequent steps receive accumulated outputs from prior completed steps", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });

    const outputA = makeStepOutput({
      output: "analysis result",
      outputFiles: ["a.md"],
    });
    const outputB = makeStepOutput({
      output: "implementation result",
      outputFiles: ["b.ts"],
    });

    const dispatch = makeDispatch()
      .mockResolvedValueOnce(outputA)
      .mockResolvedValueOnce(outputB)
      .mockResolvedValueOnce(makeStepOutput());

    await executeTask(task, gateConfig, dispatch);

    const ctx1 = dispatch.mock.calls[0][2];
    expect(ctx1.priorOutputs).toEqual({});

    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toHaveLength(1);
    expect(ctx2.priorOutputs["step-a"]).toEqual(outputA);

    const ctx3 = dispatch.mock.calls[2][2];
    expect(Object.keys(ctx3.priorOutputs)).toHaveLength(2);
    expect(ctx3.priorOutputs["step-a"]).toEqual(outputA);
    expect(ctx3.priorOutputs["step-b"]).toEqual(outputB);
  });

  it("failed step outputs are not accumulated", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });

    const outputA = makeStepOutput({ output: "step-a data" });
    const outputB = makeStepOutput({ output: "", error: "step-b failed" });

    const dispatch = makeDispatch()
      .mockResolvedValueOnce(outputA)
      .mockResolvedValueOnce(outputB);

    const result = await executeTask(task, gateConfig, dispatch);

    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toHaveLength(1);
    expect(ctx2.priorOutputs["step-a"]).toEqual(outputA);

    expect(result.status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("accumulated outputs map is not mutated by downstream consumers", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });
    const accumulatedOutputs: Record<string, StepOutput> = {
      "step-a": makeStepOutput({ output: "original" }),
    };

    const context = buildStepContext(
      task,
      gateConfig,
      "step-one",
      accumulatedOutputs,
    );

    context.priorOutputs["step-injected"] = makeStepOutput({
      output: "injected",
    });

    expect(accumulatedOutputs["step-injected"]).toBeUndefined();
    expect(Object.keys(accumulatedOutputs)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// Behavior 2: Thread Creation Ordering
// ---------------------------------------------------------------
describe("thread creation ordering", () => {
  it("Adapter interface includes createThread method", () => {
    const adapter = makeAdapter();

    expect(typeof adapter.createThread).toBe("function");
  });

  it("createThread returns the thread timestamp", async () => {
    const adapter = makeAdapter("thread.9876");

    const threadTs = await adapter.createThread("C123", "Starting task");
    expect(threadTs).toBe("thread.9876");
  });
});

// ---------------------------------------------------------------
// Behavior 3: Progress Callback Emission
// ---------------------------------------------------------------
describe("progress callback emission", () => {
  it("emits started event on subtask activation", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    expect(onProgress).toHaveBeenCalled();
    const firstCall = onProgress.mock.calls[0][0] as ProgressEvent;
    expect(firstCall.status).toBe("started");
    expect(firstCall.stepIndex).toBe(0);
    expect(firstCall.totalSteps).toBe(1);
    expect(firstCall.stepName).toBe("Analyze");
    expect(firstCall.executionType).toBe("agent");
  });

  it("emits completed event on subtask completion", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    const secondCall = onProgress.mock.calls[1][0] as ProgressEvent;
    expect(secondCall.status).toBe("completed");
    expect(secondCall.stepIndex).toBe(0);
    expect(typeof secondCall.duration).toBe("number");
    expect(secondCall.duration).toBeGreaterThanOrEqual(0);
  });

  it("emits failed event on subtask failure", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch().mockResolvedValue(
      makeStepOutput({ error: "timeout" }),
    );
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    const failedEvent = onProgress.mock.calls.find(
      (call: unknown[]) => (call[0] as ProgressEvent).status === "failed",
    );
    expect(failedEvent).toBeDefined();
    const event = failedEvent![0] as ProgressEvent;
    expect(event.status).toBe("failed");
    expect(event.error).toBe("timeout");
  });

  it("callback error does not crash executor", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First" },
      "step-b": { type: "script", behavior: "Second" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("callback failed");
      })
      .mockImplementation(() => {
        /* subsequent calls succeed */
      });

    const result = await executeTask(task, gateConfig, dispatch, onProgress);

    expect(result.status).toBe("completed");
    for (const subtask of result.subtasks!) {
      expect(subtask.status).toBe("completed");
    }
    expect(onProgress.mock.calls.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------
// Behavior 4: Stderr Batcher Lifecycle
// ---------------------------------------------------------------
describe("stderr batcher lifecycle", () => {
  it("factory returns push, flush, dispose interface", () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    expect(typeof batcher.push).toBe("function");
    expect(typeof batcher.flush).toBe("function");
    expect(typeof batcher.dispose).toBe("function");

    batcher.dispose();
  });

  it("accumulates and flushes lines to sink", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["line1", "line2"]);
    await batcher.flush();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("line1\nline2");

    await batcher.dispose();
  });

  it("auto-flushes at configured interval", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn().mockResolvedValue(undefined);
      const batcher = createStderrBatcher(sink, 1000);

      batcher.push(["auto-line"]);

      await vi.advanceTimersByTimeAsync(999);
      expect(sink).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sink).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledWith("auto-line");

      await batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose stops auto-flush and drains buffer", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn().mockResolvedValue(undefined);
      const batcher = createStderrBatcher(sink, 1000);

      batcher.push(["pre-dispose"]);
      await batcher.dispose();

      expect(sink).toHaveBeenCalledOnce();

      sink.mockClear();
      await vi.advanceTimersByTimeAsync(2000);

      expect(sink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------
// Behavior 5: Retry Counting and Re-execution
// ---------------------------------------------------------------
describe("retry counting and re-execution", () => {
  it("no retry when maxRetries is 0 (default behavior)", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
    });
    const dispatch = makeDispatch()
      .mockResolvedValue(makeStepOutput({ error: "step failed" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("failed");
    expect(result.subtasks![0].status).toBe("failed");
    expect(result.subtasks![0].attempt).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retries once when maxRetries is 1 and first attempt fails", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = makeDispatch()
      .mockResolvedValueOnce(makeStepOutput({ error: "transient failure" }))
      .mockResolvedValueOnce(makeStepOutput({ output: "success on retry" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![0].attempt).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("fails permanently after retries exhausted", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = makeDispatch()
      .mockResolvedValue(makeStepOutput({ error: "persistent failure" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].status).toBe("failed");
    expect(result.subtasks![0].attempt).toBe(2);
    expect(result.status).toBe("failed");
  });

  it("attempt counter increments on each retry", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 2 } },
    });
    const capturedAttempts: number[] = [];
    const dispatch = makeDispatch()
      .mockImplementation(async () => {
        capturedAttempts.push(task.subtasks![0].attempt);
        if (capturedAttempts.length < 3) {
          return makeStepOutput({
            error: `fail attempt ${capturedAttempts.length}`,
          });
        }
        return makeStepOutput({ output: "success" });
      });

    await executeTask(task, gateConfig, dispatch);

    expect(capturedAttempts).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------
// Behavior 6: Env Var Interpolation Scoping
// ---------------------------------------------------------------
describe("env var interpolation scoping", () => {
  const ENV_KEY = "REGRESSION_TEST_ENV_VAR_2A";

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("resolves env.VAR in script step env values", () => {
    process.env[ENV_KEY] = "resolved-value-123";

    const parsed: Record<string, unknown> = {
      steps: {
        "run-script": {
          execution: {
            type: "script",
            command: "node run.js",
            env: {
              MY_VAR: `{{env.${ENV_KEY}}}`,
            },
            timeoutMs: 30000,
          },
        },
      },
    };

    const { result, errors } = interpolateEnvVars(parsed, "test.yaml");

    expect(errors).toHaveLength(0);
    const steps = result.steps as Record<string, Record<string, unknown>>;
    const execution = steps["run-script"].execution as Record<string, unknown>;
    const env = execution.env as Record<string, string>;
    expect(env.MY_VAR).toBe("resolved-value-123");
  });

  it("produces error for undefined env var", () => {
    delete process.env[ENV_KEY];

    const parsed: Record<string, unknown> = {
      steps: {
        "run-script": {
          execution: {
            type: "script",
            command: "node run.js",
            env: {
              SECRET: `{{env.${ENV_KEY}}}`,
            },
            timeoutMs: 30000,
          },
        },
      },
    };

    const { errors } = interpolateEnvVars(parsed, "test.yaml");

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.message.includes(ENV_KEY))).toBe(true);
  });

  it("does not interpolate non-env fields", () => {
    process.env[ENV_KEY] = "should-not-appear";

    const parsed: Record<string, unknown> = {
      gate: {
        id: "test-gate",
        description: `Uses {{env.${ENV_KEY}}} template`,
      },
      steps: {
        "run-script": {
          execution: {
            type: "script",
            command: "node run.js",
            timeoutMs: 30000,
          },
          behavior: `References {{env.${ENV_KEY}}} in behavior`,
        },
      },
    };

    const { result } = interpolateEnvVars(parsed, "test.yaml");

    const gate = result.gate as Record<string, unknown>;
    expect(gate.description).toContain(`{{env.${ENV_KEY}}}`);
    expect(gate.description).not.toContain("should-not-appear");

    const steps = result.steps as Record<string, Record<string, unknown>>;
    expect(steps["run-script"].behavior).toContain(`{{env.${ENV_KEY}}}`);
    expect(steps["run-script"].behavior).not.toContain("should-not-appear");
  });
});
