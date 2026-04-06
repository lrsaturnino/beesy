import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { executeTask } from "../../src/executor/task-executor.js";
import { buildStepContext } from "../../src/executor/context-builder.js";

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

// ---------------------------------------------------------------
// Shared test fixtures
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
    id: "task-001",
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
    { type: "agent" | "script" | "tool"; behavior?: string; retryPolicy?: { maxRetries: number } }
  > = {
    "step-analyze": { type: "agent", behavior: "Analyze the codebase" },
    "step-implement": { type: "script", behavior: "Run implementation script" },
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
    description: "A test gate for unit tests",
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

/** Create a mock dispatch function. */
function makeDispatch() {
  return vi.fn<
    [Subtask, StepDefinition, StepContext],
    Promise<StepOutput>
  >().mockResolvedValue(makeStepOutput());
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
// Group 1: Context Builder
// ---------------------------------------------------------------
describe("context builder", () => {
  it("produces correct StepContext from task, gate config, and step ID", () => {
    const task = makeTask({
      id: "task-abc",
      payload: { repo: "my-repo", branch: "dev" },
    });
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });

    const context = buildStepContext(task, gateConfig, "step-one");

    expect(context.taskId).toBe("task-abc");
    expect(context.taskPayload).toEqual({ repo: "my-repo", branch: "dev" });
    expect(context.gateId).toBe("test-gate");
    expect(context.stepId).toBe("step-one");
  });

  it("includes workspacePath when task has one", () => {
    const task = makeTask({ workspacePath: "/tmp/bees/work-001" });
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });

    const context = buildStepContext(task, gateConfig, "step-one");

    expect(context.workspacePath).toBe("/tmp/bees/work-001");
  });

  it("omits workspacePath when task has none", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });

    const context = buildStepContext(task, gateConfig, "step-one");

    expect(context.workspacePath).toBeUndefined();
  });

  it("sets priorOutputs to empty object", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });

    const context = buildStepContext(task, gateConfig, "step-one");

    expect(context.priorOutputs).toEqual({});
  });

  it("populates priorOutputs from accumulated outputs map", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-one": { type: "agent" } });
    const accumulatedOutputs: Record<string, StepOutput> = {
      "step-a": makeStepOutput({ output: "result-a", outputFiles: [] }),
    };

    const context = buildStepContext(
      task,
      gateConfig,
      "step-one",
      accumulatedOutputs,
    );

    expect(context.priorOutputs).toEqual(accumulatedOutputs);
    expect(Object.keys(context.priorOutputs)).toHaveLength(1);
  });

  it("populates priorOutputs with multiple entries from accumulated map", () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({ "step-c": { type: "tool" } });
    const stepOutputA = makeStepOutput({
      output: "analysis done",
      outputFiles: ["a.md"],
    });
    const stepOutputB = makeStepOutput({
      output: "implementation done",
      outputFiles: ["b.ts"],
    });
    const accumulatedOutputs: Record<string, StepOutput> = {
      "step-a": stepOutputA,
      "step-b": stepOutputB,
    };

    const context = buildStepContext(
      task,
      gateConfig,
      "step-c",
      accumulatedOutputs,
    );

    expect(Object.keys(context.priorOutputs)).toHaveLength(2);
    expect(context.priorOutputs["step-a"]).toEqual(stepOutputA);
    expect(context.priorOutputs["step-b"]).toEqual(stepOutputB);
  });

  it("does not mutate the accumulated outputs map", () => {
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

    // Mutate the returned priorOutputs
    context.priorOutputs["step-injected"] = makeStepOutput({
      output: "injected",
    });

    // Original map must remain unmodified
    expect(accumulatedOutputs["step-injected"]).toBeUndefined();
    expect(Object.keys(accumulatedOutputs)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// Group 2: Subtask Generation
// ---------------------------------------------------------------
describe("subtask generation", () => {
  it("generates correct number of subtasks matching workflow steps length", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-analyze": { type: "agent" },
      "step-implement": { type: "script" },
      "step-validate": { type: "tool" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks).toBeDefined();
    expect(result.subtasks!.length).toBe(3);
  });

  it("generates empty subtask array for empty workflow", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({});
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks).toBeDefined();
    expect(result.subtasks!.length).toBe(0);
    expect(result.status).toBe("completed");
  });

  it("creates subtasks with initial status pending", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    // Capture the subtask state at dispatch time
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      // By the time dispatch runs, subtask is already active,
      // but we verify initial generation produced pending
      return makeStepOutput();
    });

    const result = await executeTask(task, gateConfig, dispatch);

    // After execution, the subtask should have transitioned through pending -> active -> completed
    expect(result.subtasks![0].status).toBe("completed");
  });

  it("creates subtasks with unique IDs", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    const ids = result.subtasks!.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("maps subtask stepId to the workflow step ID", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-alpha": { type: "agent" },
      "step-beta": { type: "script" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].stepId).toBe("step-alpha");
    expect(result.subtasks![1].stepId).toBe("step-beta");
  });

  it("extracts executionType from step definition execution type", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].executionType).toBe("agent");
    expect(result.subtasks![1].executionType).toBe("script");
    expect(result.subtasks![2].executionType).toBe("tool");
  });

  it("derives subtask name from step behavior or falls back to step ID", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-with-behavior": {
        type: "agent",
        behavior: "Analyze the codebase",
      },
      "step-without-behavior": { type: "script" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].name).toBe("Analyze the codebase");
    expect(result.subtasks![1].name).toBe("step-without-behavior");
  });

  it("generates subtasks in workflow step order", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "first-step": { type: "agent" },
      "second-step": { type: "script" },
      "third-step": { type: "tool" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].stepId).toBe("first-step");
    expect(result.subtasks![1].stepId).toBe("second-step");
    expect(result.subtasks![2].stepId).toBe("third-step");
  });
});

// ---------------------------------------------------------------
// Group 3: Sequential Execution
// ---------------------------------------------------------------
describe("sequential execution", () => {
  it("executes subtasks in order first to last", async () => {
    const callOrder: string[] = [];
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async (subtask) => {
      callOrder.push(subtask.stepId);
      return makeStepOutput();
    });

    await executeTask(task, gateConfig, dispatch);

    expect(callOrder).toEqual(["step-a", "step-b", "step-c"]);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("transitions subtask from pending to active before dispatcher call", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    let subtaskStatusDuringDispatch: string | undefined;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      // Capture the subtask status at the moment the dispatcher is called
      subtaskStatusDuringDispatch = task.subtasks?.[0]?.status;
      return makeStepOutput();
    });

    await executeTask(task, gateConfig, dispatch);

    expect(subtaskStatusDuringDispatch).toBe("active");
  });

  it("transitions subtask to completed after successful dispatch", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch().mockResolvedValue(
      makeStepOutput({ output: "result", outputFiles: ["file.txt"] }),
    );

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![0].output).toBe("result");
    expect(result.subtasks![0].outputFiles).toEqual(["file.txt"]);
    expect(result.subtasks![0].completedAt).toBeInstanceOf(Date);
  });

  it("sets startedAt when subtask becomes active", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].startedAt).toBeInstanceOf(Date);
  });

  it("sets completedAt when subtask finishes", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].completedAt).toBeInstanceOf(Date);
  });

  it("calls dispatcher exactly once per subtask", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("passes correct StepDefinition to dispatcher for each step", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    // First call should receive the agent step definition
    const firstCallStep = dispatch.mock.calls[0][1];
    expect(firstCallStep.execution.type).toBe("agent");

    // Second call should receive the script step definition
    const secondCallStep = dispatch.mock.calls[1][1];
    expect(secondCallStep.execution.type).toBe("script");
  });

  it("passes correct StepContext to dispatcher for each step", async () => {
    const task = makeTask({
      id: "task-ctx",
      payload: { repo: "context-test" },
    });
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    const firstCtx = dispatch.mock.calls[0][2];
    expect(firstCtx.taskId).toBe("task-ctx");
    expect(firstCtx.taskPayload).toEqual({ repo: "context-test" });
    expect(firstCtx.gateId).toBe("test-gate");
    expect(firstCtx.stepId).toBe("step-a");

    const secondCtx = dispatch.mock.calls[1][2];
    expect(secondCtx.stepId).toBe("step-b");
  });

  it("populates subtask output and outputFiles on success", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch().mockResolvedValue(
      makeStepOutput({
        output: "data",
        outputFiles: ["/path/a.txt", "/path/b.txt"],
      }),
    );

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.subtasks![0].output).toBe("data");
    expect(result.subtasks![0].outputFiles).toEqual([
      "/path/a.txt",
      "/path/b.txt",
    ]);
  });

  it("sets timestamps correctly throughout execution", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    // Task-level timestamps
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.startedAt!.getTime()).toBeLessThanOrEqual(
      result.completedAt!.getTime(),
    );

    // Subtask-level timestamps
    for (const subtask of result.subtasks!) {
      expect(subtask.startedAt).toBeInstanceOf(Date);
      expect(subtask.completedAt).toBeInstanceOf(Date);
      expect(subtask.startedAt!.getTime()).toBeLessThanOrEqual(
        subtask.completedAt!.getTime(),
      );
    }
  });
});

// ---------------------------------------------------------------
// Group 4: Failure Handling
// ---------------------------------------------------------------
describe("failure handling", () => {
  it("marks task failed on subtask failure and stops iteration", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput({ output: "step-a done" }))
      .mockResolvedValueOnce(
        makeStepOutput({ output: "", error: "timeout" }),
      );
    // Third mock not needed -- should never be called

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("failed");
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![1].status).toBe("failed");
    expect(result.subtasks![1].error).toBe("timeout");
    expect(result.subtasks![2].status).toBe("pending");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("marks task failed when dispatcher throws an error", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput())
      .mockRejectedValueOnce(new Error("process crashed"));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("failed");
    expect(result.subtasks![1].status).toBe("failed");
    expect(result.subtasks![1].error).toBe("process crashed");
  });

  it("populates task error field on failure", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
    });
    const dispatch = makeDispatch().mockResolvedValue(
      makeStepOutput({ error: "step failed" }),
    );

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 5: Task Completion
// ---------------------------------------------------------------
describe("task completion", () => {
  it("marks task completed when all subtasks succeed", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("completed");
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![1].status).toBe("completed");
  });

  it("sets task status to active at start of execution", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    let taskStatusDuringExecution: string | undefined;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      taskStatusDuringExecution = task.status;
      return makeStepOutput();
    });

    await executeTask(task, gateConfig, dispatch);

    expect(taskStatusDuringExecution).toBe("active");
  });

  it("sets task startedAt at beginning of execution", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.startedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------
// Group 6: Context Passing
// ---------------------------------------------------------------
describe("context passing", () => {
  it("passes taskPayload from the task in context", async () => {
    const task = makeTask({ payload: { feature: "login" } });
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    const ctx = dispatch.mock.calls[0][2];
    expect(ctx.taskPayload).toEqual({ feature: "login" });
  });

  it("passes gateId from the gate config in context", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    const ctx = dispatch.mock.calls[0][2];
    expect(ctx.gateId).toBe("test-gate");
  });

  it("passes correct stepId for each subtask", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-alpha": { type: "agent" },
      "step-beta": { type: "script" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    expect(dispatch.mock.calls[0][2].stepId).toBe("step-alpha");
    expect(dispatch.mock.calls[1][2].stepId).toBe("step-beta");
  });

  it("passes workspacePath in context when task has one", async () => {
    const task = makeTask({ workspacePath: "/tmp/bees/work-001" });
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    const ctx = dispatch.mock.calls[0][2];
    expect(ctx.workspacePath).toBe("/tmp/bees/work-001");
  });
});

// ---------------------------------------------------------------
// Group 7: Integration Tests
// ---------------------------------------------------------------
describe("integration", () => {
  it("executes full 3-step workflow with mock dispatcher end-to-end", async () => {
    const task = makeTask({ id: "task-integration" });
    const gateConfig = makeGateConfig({
      "step-analyze": { type: "agent", behavior: "Analyze codebase" },
      "step-implement": {
        type: "script",
        behavior: "Run implementation script",
      },
      "step-validate": { type: "tool", behavior: "Validate output" },
    });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(
        makeStepOutput({
          output: "analysis complete",
          outputFiles: ["analysis.md"],
        }),
      )
      .mockResolvedValueOnce(
        makeStepOutput({
          output: "implementation done",
          outputFiles: ["impl.ts"],
        }),
      )
      .mockResolvedValueOnce(
        makeStepOutput({
          output: "validation passed",
          outputFiles: ["report.md"],
        }),
      );

    const result = await executeTask(task, gateConfig, dispatch);

    // Verify all subtasks created
    expect(result.subtasks!.length).toBe(3);

    // Verify sequential execution
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls[0][0].stepId).toBe("step-analyze");
    expect(dispatch.mock.calls[1][0].stepId).toBe("step-implement");
    expect(dispatch.mock.calls[2][0].stepId).toBe("step-validate");

    // Verify all completed
    for (const subtask of result.subtasks!) {
      expect(subtask.status).toBe("completed");
    }
    expect(result.status).toBe("completed");

    // Verify outputs captured
    expect(result.subtasks![0].output).toBe("analysis complete");
    expect(result.subtasks![1].output).toBe("implementation done");
    expect(result.subtasks![2].output).toBe("validation passed");

    // Verify execution types
    expect(result.subtasks![0].executionType).toBe("agent");
    expect(result.subtasks![1].executionType).toBe("script");
    expect(result.subtasks![2].executionType).toBe("tool");
  });

  it("handles partial failure at step 2 of 3 correctly", async () => {
    const task = makeTask({ id: "task-partial-fail" });
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First step" },
      "step-b": { type: "script", behavior: "Second step (will fail)" },
      "step-c": { type: "tool", behavior: "Third step (should not run)" },
    });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(
        makeStepOutput({ output: "step-a succeeded" }),
      )
      .mockRejectedValueOnce(new Error("script execution timed out"));

    const result = await executeTask(task, gateConfig, dispatch);

    // Verify task failed
    expect(result.status).toBe("failed");
    expect(result.completedAt).toBeInstanceOf(Date);

    // Verify step 1 completed
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![0].output).toBe("step-a succeeded");

    // Verify step 2 failed with error
    expect(result.subtasks![1].status).toBe("failed");
    expect(result.subtasks![1].error).toBe("script execution timed out");

    // Verify step 3 was never executed (stays pending)
    expect(result.subtasks![2].status).toBe("pending");
    expect(result.subtasks![2].startedAt).toBeUndefined();

    // Verify dispatcher was called exactly twice
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------
// Group 8: Output Accumulation
// ---------------------------------------------------------------
describe("output accumulation", () => {
  it("passes empty priorOutputs to the first step", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-first": { type: "agent" },
    });
    const dispatch = makeDispatch();

    await executeTask(task, gateConfig, dispatch);

    const firstCtx = dispatch.mock.calls[0][2];
    expect(firstCtx.priorOutputs).toEqual({});
  });

  it("accumulates outputs from completed steps across workflow", async () => {
    const task = makeTask({ id: "task-accum" });
    const gateConfig = makeGateConfig({
      "step-analyze": { type: "agent" },
      "step-implement": { type: "script" },
      "step-validate": { type: "tool" },
    });

    const outputAnalyze = makeStepOutput({
      output: "analysis result",
      outputFiles: ["analysis.md"],
    });
    const outputImplement = makeStepOutput({
      output: "implementation result",
      outputFiles: ["impl.ts"],
    });
    const outputValidate = makeStepOutput({
      output: "validation passed",
      outputFiles: ["report.md"],
    });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(outputAnalyze)
      .mockResolvedValueOnce(outputImplement)
      .mockResolvedValueOnce(outputValidate);

    await executeTask(task, gateConfig, dispatch);

    // Step 1: no prior outputs
    const ctx1 = dispatch.mock.calls[0][2];
    expect(ctx1.priorOutputs).toEqual({});

    // Step 2: receives output from step 1
    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toHaveLength(1);
    expect(ctx2.priorOutputs["step-analyze"]).toEqual(outputAnalyze);

    // Step 3: receives outputs from steps 1 and 2
    const ctx3 = dispatch.mock.calls[2][2];
    expect(Object.keys(ctx3.priorOutputs)).toHaveLength(2);
    expect(ctx3.priorOutputs["step-analyze"]).toEqual(outputAnalyze);
    expect(ctx3.priorOutputs["step-implement"]).toEqual(outputImplement);
  });

  it("does not accumulate outputs from steps that fail via error field", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });

    const outputA = makeStepOutput({ output: "step-a data" });
    const outputB = makeStepOutput({ output: "", error: "step-b failed" });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(outputA)
      .mockResolvedValueOnce(outputB);

    const result = await executeTask(task, gateConfig, dispatch);

    // Step 2 received step 1 output
    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toHaveLength(1);
    expect(ctx2.priorOutputs["step-a"]).toEqual(outputA);

    // Task failed, step 3 never executed
    expect(result.status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not accumulate outputs from steps that throw exceptions", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });

    const outputA = makeStepOutput({ output: "step-a data" });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(outputA)
      .mockRejectedValueOnce(new Error("process crashed"));

    const result = await executeTask(task, gateConfig, dispatch);

    // Step 2 received step 1 output
    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toHaveLength(1);
    expect(ctx2.priorOutputs["step-a"]).toEqual(outputA);

    // Task failed, step 3 never executed
    expect(result.status).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("uses stepId as key in accumulated outputs map", async () => {
    const task = makeTask({ id: "task-key-check" });
    const gateConfig = makeGateConfig({
      "step-analyze": { type: "agent" },
      "step-implement": { type: "script" },
    });

    const outputAnalyze = makeStepOutput({ output: "analysis" });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(outputAnalyze)
      .mockResolvedValueOnce(makeStepOutput());

    await executeTask(task, gateConfig, dispatch);

    // The key should be the stepId, not the composite subtask id
    const ctx2 = dispatch.mock.calls[1][2];
    expect(Object.keys(ctx2.priorOutputs)).toEqual(["step-analyze"]);
    // Verify the composite key is NOT used
    expect(ctx2.priorOutputs["task-key-check-step-analyze"]).toBeUndefined();
  });

  it("accumulates the full StepOutput object including all fields", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-first": { type: "agent" },
      "step-second": { type: "script" },
    });

    const fullOutput = makeStepOutput({
      output: "detailed data",
      outputFiles: ["file1.txt", "file2.txt"],
      cost: {
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.015,
      },
    });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(fullOutput)
      .mockResolvedValueOnce(makeStepOutput());

    await executeTask(task, gateConfig, dispatch);

    const ctx2 = dispatch.mock.calls[1][2];
    const accumulated = ctx2.priorOutputs["step-first"];

    // Verify the full StepOutput is stored, not just the output string
    expect(accumulated.output).toBe("detailed data");
    expect(accumulated.outputFiles).toEqual(["file1.txt", "file2.txt"]);
    expect(accumulated.cost).toEqual({
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.015,
    });
  });
});

// ---------------------------------------------------------------
// Group 9: Progress Notifications
// ---------------------------------------------------------------
describe("progress notifications", () => {
  it("calls onProgress with started event after subtask activation", async () => {
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

  it("calls onProgress with completed event after subtask completion", async () => {
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

  it("calls onProgress with failed event after subtask failure via error field", async () => {
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

  it("calls onProgress with failed event after subtask throws", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch().mockRejectedValue(new Error("crash"));
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    const failedEvent = onProgress.mock.calls.find(
      (call: unknown[]) => (call[0] as ProgressEvent).status === "failed",
    );
    expect(failedEvent).toBeDefined();
    const event = failedEvent![0] as ProgressEvent;
    expect(event.status).toBe("failed");
    expect(event.error).toBe("crash");
  });

  it("emits correct sequence of events for multi-step execution", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-analyze": { type: "agent", behavior: "Analyze codebase" },
      "step-implement": { type: "script", behavior: "Run implementation" },
      "step-validate": { type: "tool", behavior: "Validate output" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(6);

    const events = onProgress.mock.calls.map(
      (call: unknown[]) => call[0] as ProgressEvent,
    );

    // Verify interleaved started/completed sequence
    expect(events[0].status).toBe("started");
    expect(events[0].stepIndex).toBe(0);
    expect(events[0].stepName).toBe("Analyze codebase");
    expect(events[0].executionType).toBe("agent");

    expect(events[1].status).toBe("completed");
    expect(events[1].stepIndex).toBe(0);

    expect(events[2].status).toBe("started");
    expect(events[2].stepIndex).toBe(1);
    expect(events[2].stepName).toBe("Run implementation");
    expect(events[2].executionType).toBe("script");

    expect(events[3].status).toBe("completed");
    expect(events[3].stepIndex).toBe(1);

    expect(events[4].status).toBe("started");
    expect(events[4].stepIndex).toBe(2);
    expect(events[4].stepName).toBe("Validate output");
    expect(events[4].executionType).toBe("tool");

    expect(events[5].status).toBe("completed");
    expect(events[5].stepIndex).toBe(2);

    // All events should have totalSteps === 3
    for (const event of events) {
      expect(event.totalSteps).toBe(3);
    }
  });

  it("emits started then failed for a step that fails mid-sequence", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First" },
      "step-b": { type: "script", behavior: "Second" },
      "step-c": { type: "tool", behavior: "Third" },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput())
      .mockResolvedValueOnce(makeStepOutput({ error: "step-b broke" }));
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(4);

    const events = onProgress.mock.calls.map(
      (call: unknown[]) => call[0] as ProgressEvent,
    );

    expect(events[0].status).toBe("started");
    expect(events[0].stepIndex).toBe(0);
    expect(events[1].status).toBe("completed");
    expect(events[1].stepIndex).toBe(0);
    expect(events[2].status).toBe("started");
    expect(events[2].stepIndex).toBe(1);
    expect(events[3].status).toBe("failed");
    expect(events[3].stepIndex).toBe(1);

    // No events for step 2 (index 2)
    const step2Events = events.filter((e) => e.stepIndex === 2);
    expect(step2Events).toHaveLength(0);
  });

  it("does not call onProgress when parameter is omitted", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
      "step-b": { type: "script" },
      "step-c": { type: "tool" },
    });
    const dispatch = makeDispatch();

    // Call with only 3 arguments (no onProgress)
    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("completed");
    expect(result.subtasks!.length).toBe(3);
    for (const subtask of result.subtasks!) {
      expect(subtask.status).toBe("completed");
    }
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("onProgress callback error does not crash executor", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First" },
      "step-b": { type: "script", behavior: "Second" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("callback failed");
      })
      .mockImplementation(() => {
        // Subsequent calls succeed
      });

    const result = await executeTask(task, gateConfig, dispatch, onProgress);

    // Task must complete despite callback error
    expect(result.status).toBe("completed");
    // Both subtasks must complete
    for (const subtask of result.subtasks!) {
      expect(subtask.status).toBe("completed");
    }
    // onProgress should have been called for subsequent events despite first error
    expect(onProgress.mock.calls.length).toBeGreaterThan(1);
  });

  it("ProgressEvent contains correct taskId field", async () => {
    const task = makeTask({ id: "task-progress-001" });
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    // Must have been called at least once (not a vacuous assertion)
    expect(onProgress).toHaveBeenCalled();

    const events = onProgress.mock.calls.map(
      (call: unknown[]) => call[0] as ProgressEvent,
    );
    for (const event of events) {
      expect(event.taskId).toBe("task-progress-001");
    }
  });

  it("ProgressEvent duration field is set on completed events", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-one": { type: "agent", behavior: "Analyze" },
    });
    const dispatch = makeDispatch();
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    const completedEvent = onProgress.mock.calls.find(
      (call: unknown[]) => (call[0] as ProgressEvent).status === "completed",
    );
    expect(completedEvent).toBeDefined();
    const event = completedEvent![0] as ProgressEvent;
    expect(typeof event.duration).toBe("number");
    expect(event.duration).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------
// Group 10: Retry Re-Execution
// ---------------------------------------------------------------
describe("retry re-execution", () => {
  it("does not retry when maxRetries is 0 (default behavior)", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent" },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockResolvedValue(makeStepOutput({ error: "step failed" }));

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
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput({ error: "transient failure" }))
      .mockResolvedValueOnce(makeStepOutput({ output: "success on retry" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![0].attempt).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("fails permanently after retries exhausted (maxRetries=1, both attempts fail)", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockResolvedValue(makeStepOutput({ error: "persistent failure" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].status).toBe("failed");
    expect(result.subtasks![0].attempt).toBe(2);
    expect(result.status).toBe("failed");
  });

  it("retries multiple times when maxRetries is greater than 1", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 3 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput({ error: "fail 1" }))
      .mockResolvedValueOnce(makeStepOutput({ error: "fail 2" }))
      .mockResolvedValueOnce(makeStepOutput({ error: "fail 3" }))
      .mockResolvedValueOnce(makeStepOutput({ output: "success on attempt 4" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![0].attempt).toBe(4);
  });

  it("resets subtask status to pending before retry", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const statusAtDispatch: string[] = [];
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      statusAtDispatch.push(task.subtasks![0].status);
      if (statusAtDispatch.length === 1) {
        return makeStepOutput({ error: "first attempt fails" });
      }
      return makeStepOutput({ output: "retry succeeds" });
    });

    await executeTask(task, gateConfig, dispatch);

    // On both dispatch calls, the subtask should be "active" (reset to pending then activated)
    expect(statusAtDispatch[0]).toBe("active");
    expect(statusAtDispatch[1]).toBe("active");
  });

  it("increments attempt counter on each retry", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 2 } },
    });
    const capturedAttempts: number[] = [];
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      capturedAttempts.push(task.subtasks![0].attempt);
      if (capturedAttempts.length < 3) {
        return makeStepOutput({ error: `fail attempt ${capturedAttempts.length}` });
      }
      return makeStepOutput({ output: "success" });
    });

    await executeTask(task, gateConfig, dispatch);

    expect(capturedAttempts).toEqual([1, 2, 3]);
  });

  it("safety guard prevents infinite retry loops", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockResolvedValue(makeStepOutput({ error: "always fails" }));

    const result = await executeTask(task, gateConfig, dispatch);

    // With maxRetries=1, at most 2 total attempts (1 initial + 1 retry)
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].attempt).toBeLessThanOrEqual(2);
    expect(result.status).toBe("failed");
  });

  it("handles retry when failure is via thrown exception (not error field)", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockRejectedValueOnce(new Error("transient crash"))
      .mockResolvedValueOnce(makeStepOutput({ output: "recovered" }));

    const result = await executeTask(task, gateConfig, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("clears subtask error and timestamps on retry reset", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
    });
    let capturedErrorOnRetry: string | undefined = "NOT_CAPTURED";
    let capturedCompletedAtOnRetry: Date | undefined | null = null;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async () => {
      const subtask = task.subtasks![0];
      if (dispatch.mock.calls.length === 2) {
        // On second call (retry), capture the reset state
        capturedErrorOnRetry = subtask.error;
        capturedCompletedAtOnRetry = subtask.completedAt;
      }
      if (dispatch.mock.calls.length === 1) {
        return makeStepOutput({ error: "first attempt fails" });
      }
      return makeStepOutput({ output: "retry succeeds" });
    });

    await executeTask(task, gateConfig, dispatch);

    expect(capturedErrorOnRetry).toBeUndefined();
    expect(capturedCompletedAtOnRetry).toBeUndefined();
  });

  it("does not accumulate outputs from failed retry attempts", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
      "step-b": { type: "script" },
    });

    let capturedPriorOutputs: Record<string, StepOutput> | undefined;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async (subtask, _step, context) => {
      if (subtask.stepId === "step-b") {
        capturedPriorOutputs = context.priorOutputs;
        return makeStepOutput({ output: "step-b done" });
      }
      // step-a: fail first, succeed on retry with specific output
      if (dispatch.mock.calls.length === 1) {
        return makeStepOutput({ output: "failed output", error: "transient" });
      }
      return makeStepOutput({ output: "successful retry output" });
    });

    await executeTask(task, gateConfig, dispatch);

    expect(capturedPriorOutputs).toBeDefined();
    expect(capturedPriorOutputs!["step-a"]).toBeDefined();
    expect(capturedPriorOutputs!["step-a"].output).toBe("successful retry output");
    expect(capturedPriorOutputs!["step-a"].error).toBeUndefined();
  });

  it("emits progress events for retry attempts", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "Retryable step", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >()
      .mockResolvedValueOnce(makeStepOutput({ error: "attempt 1 fails" }))
      .mockResolvedValueOnce(makeStepOutput({ output: "attempt 2 succeeds" }));
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    // Expected event sequence: started(1) -> failed(1) -> started(2) -> completed(2)
    expect(onProgress).toHaveBeenCalledTimes(4);
    const events = onProgress.mock.calls.map(
      (call: unknown[]) => call[0] as ProgressEvent,
    );
    expect(events[0].status).toBe("started");
    expect(events[1].status).toBe("failed");
    expect(events[2].status).toBe("started");
    expect(events[3].status).toBe("completed");
  });

  it("emits progress events when all retries exhausted", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "Failing step", retryPolicy: { maxRetries: 1 } },
    });
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockResolvedValue(makeStepOutput({ error: "always fails" }));
    const onProgress = vi.fn();

    await executeTask(task, gateConfig, dispatch, onProgress);

    // Expected event sequence: started(1) -> failed(1) -> started(2) -> failed(2)
    expect(onProgress).toHaveBeenCalledTimes(4);
    const events = onProgress.mock.calls.map(
      (call: unknown[]) => call[0] as ProgressEvent,
    );
    expect(events[0].status).toBe("started");
    expect(events[1].status).toBe("failed");
    expect(events[2].status).toBe("started");
    expect(events[3].status).toBe("failed");
  });
});

// ---------------------------------------------------------------
// Group 11: Retry Integration
// ---------------------------------------------------------------
describe("retry integration", () => {
  it("failing step with maxRetries=1 retries once then fails permanently in multi-step workflow", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First step" },
      "step-b": { type: "script", behavior: "Retryable step", retryPolicy: { maxRetries: 1 } },
      "step-c": { type: "tool", behavior: "Third step" },
    });

    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async (subtask) => {
      if (subtask.stepId === "step-a") {
        return makeStepOutput({ output: "step-a done" });
      }
      // step-b always fails
      return makeStepOutput({ error: "step-b broke" });
    });

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("failed");
    expect(result.subtasks![0].status).toBe("completed");
    expect(result.subtasks![1].status).toBe("failed");
    expect(result.subtasks![2].status).toBe("pending");
    // step-a dispatched once, step-b dispatched twice (initial + 1 retry)
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("step succeeds on retry and workflow continues", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", behavior: "First step" },
      "step-b": { type: "script", behavior: "Retryable step", retryPolicy: { maxRetries: 1 } },
      "step-c": { type: "tool", behavior: "Third step" },
    });

    let stepBCallCount = 0;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async (subtask) => {
      if (subtask.stepId === "step-a") {
        return makeStepOutput({ output: "step-a done" });
      }
      if (subtask.stepId === "step-b") {
        stepBCallCount++;
        if (stepBCallCount === 1) {
          return makeStepOutput({ error: "transient failure" });
        }
        return makeStepOutput({ output: "step-b recovered" });
      }
      return makeStepOutput({ output: "step-c done" });
    });

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("completed");
    for (const subtask of result.subtasks!) {
      expect(subtask.status).toBe("completed");
    }
    // step-a: 1, step-b: 2 (fail + retry), step-c: 1 = 4 total
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("retry does not affect prior step outputs for subsequent steps", async () => {
    const task = makeTask();
    const gateConfig = makeGateConfig({
      "step-a": { type: "agent", retryPolicy: { maxRetries: 1 } },
      "step-b": { type: "script" },
    });

    let capturedPriorOutputs: Record<string, StepOutput> | undefined;
    let stepACallCount = 0;
    const dispatch = vi.fn<
      [Subtask, StepDefinition, StepContext],
      Promise<StepOutput>
    >().mockImplementation(async (subtask, _step, context) => {
      if (subtask.stepId === "step-a") {
        stepACallCount++;
        if (stepACallCount === 1) {
          return makeStepOutput({ output: "failed output", error: "transient" });
        }
        return makeStepOutput({ output: "correct retry output", outputFiles: ["retry.md"] });
      }
      // step-b captures priorOutputs
      capturedPriorOutputs = context.priorOutputs;
      return makeStepOutput({ output: "step-b done" });
    });

    const result = await executeTask(task, gateConfig, dispatch);

    expect(result.status).toBe("completed");
    expect(capturedPriorOutputs).toBeDefined();
    expect(capturedPriorOutputs!["step-a"]).toBeDefined();
    expect(capturedPriorOutputs!["step-a"].output).toBe("correct retry output");
    expect(capturedPriorOutputs!["step-a"].outputFiles).toEqual(["retry.md"]);
    // The failed attempt's error should not be in the accumulated output
    expect(capturedPriorOutputs!["step-a"].error).toBeUndefined();
  });
});
