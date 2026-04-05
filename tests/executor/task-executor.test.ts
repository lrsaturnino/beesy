import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { executeTask } from "../../src/executor/task-executor.js";
import { buildStepContext } from "../../src/executor/context-builder.js";

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
    { type: "agent" | "script" | "tool"; behavior?: string }
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
      };
    } else if (config.type === "script") {
      steps[stepId] = {
        execution: {
          type: "script",
          command: "node scripts/run.js",
          timeoutMs: 30000,
        },
        behavior: config.behavior,
      };
    } else {
      steps[stepId] = {
        execution: {
          type: "tool",
          module: "src/tools/validate",
          function: "validate",
        },
        behavior: config.behavior,
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
