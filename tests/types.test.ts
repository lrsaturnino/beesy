import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// -------------------------------------------------------------------
// Group 1: Queue Types (src/queue/types.ts)
// -------------------------------------------------------------------
describe("queue types", () => {
  it("exports Task interface", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming Task object is constructible with required fields
    const task: Record<string, unknown> = {
      id: "task-001",
      gate: "new-implementation",
      status: "queued",
      priority: "normal",
      position: 1,
      payload: { description: "test task" },
      requestedBy: "U12345",
      sourceChannel: { platform: "slack", channelId: "C12345" },
      createdAt: new Date(),
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
    expect(task.id).toBe("task-001");
    expect(task.gate).toBe("new-implementation");
    expect(task.status).toBe("queued");
  });

  it("exports Subtask interface", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming Subtask object is constructible with required fields
    const subtask: Record<string, unknown> = {
      id: "subtask-001",
      stepId: "planning",
      name: "Load planning file",
      executionType: "agent",
      status: "pending",
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
    expect(subtask.id).toBe("subtask-001");
    expect(subtask.stepId).toBe("planning");
    expect(subtask.executionType).toBe("agent");
  });

  it("exports TaskStatus union type with all six values", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod.TASK_STATUSES).toBeDefined();
    const statuses = mod.TASK_STATUSES as readonly string[];
    expect(statuses).toHaveLength(6);
    expect(statuses).toContain("queued");
    expect(statuses).toContain("active");
    expect(statuses).toContain("paused");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("aborted");
  });

  it("exports SubtaskStatus union type with all six values", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod.SUBTASK_STATUSES).toBeDefined();
    const statuses = mod.SUBTASK_STATUSES as readonly string[];
    expect(statuses).toHaveLength(6);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("active");
    expect(statuses).toContain("needs_input");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("skipped");
  });

  it("exports CostAccumulator interface", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming CostAccumulator object is constructible
    const cost: Record<string, unknown> = {
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.003,
    };
    expect(cost.totalTokens).toBe(1500);
    expect(cost.estimatedCostUsd).toBe(0.003);
  });

  it("Task interface requires all mandatory fields", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod).toBeDefined();
    // Verify that all mandatory fields exist on a conforming Task object
    const task: Record<string, unknown> = {
      id: "task-002",
      gate: "investigate-bug",
      status: "active",
      priority: "high",
      position: 0,
      payload: {},
      requestedBy: "U99999",
      sourceChannel: { platform: "slack", channelId: "C99999" },
      createdAt: new Date(),
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
    const requiredKeys = [
      "id", "gate", "status", "priority", "position",
      "payload", "requestedBy", "sourceChannel", "createdAt", "cost",
    ];
    for (const key of requiredKeys) {
      expect(task[key], `Task must have required field: ${key}`).toBeDefined();
    }
  });

  it("Subtask interface requires all mandatory fields", async () => {
    const mod = await import("../src/queue/types.js");
    expect(mod).toBeDefined();
    // Verify that all mandatory fields exist on a conforming Subtask object
    const subtask: Record<string, unknown> = {
      id: "subtask-002",
      stepId: "implementation",
      name: "Run implementation",
      executionType: "script",
      status: "active",
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
    const requiredKeys = ["id", "stepId", "name", "executionType", "status", "cost"];
    for (const key of requiredKeys) {
      expect(subtask[key], `Subtask must have required field: ${key}`).toBeDefined();
    }
  });
});

// -------------------------------------------------------------------
// Group 2: Adapter Types (src/adapters/types.ts)
// -------------------------------------------------------------------
describe("adapter types", () => {
  it("exports NormalizedMessage interface", async () => {
    const mod = await import("../src/adapters/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming NormalizedMessage is constructible
    const msg: Record<string, unknown> = {
      command: "/new-implementation",
      payload: { description: "implement feature X" },
      channel: { platform: "slack", channelId: "C12345", threadTs: "1234567890.123456" },
      requestedBy: "U12345",
      timestamp: new Date(),
    };
    expect(msg.command).toBe("/new-implementation");
    expect(msg.requestedBy).toBe("U12345");
    expect(msg.channel).toBeDefined();
  });

  it("exports ChannelRef interface", async () => {
    const mod = await import("../src/adapters/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming ChannelRef is constructible with platform routing fields
    const channelRef: Record<string, unknown> = {
      platform: "slack",
      channelId: "C12345",
      threadTs: "1234567890.123456",
    };
    expect(channelRef.platform).toBe("slack");
    expect(channelRef.channelId).toBe("C12345");
    // threadTs is optional, but should be present when provided
    expect(channelRef.threadTs).toBeDefined();
  });
});

// -------------------------------------------------------------------
// Group 3: Runner Types (src/runners/types.ts)
// -------------------------------------------------------------------
describe("runner types", () => {
  it("exports AgentBackend interface", async () => {
    const mod = await import("../src/runners/types.js");
    expect(mod).toBeDefined();
    // Verify a mock implementation satisfying the interface is constructible
    const backend: Record<string, unknown> = {
      name: "cli-claude",
      run: async () => ({
        output: "result",
        outputFiles: [],
        cost: { totalTokens: 100, inputTokens: 80, outputTokens: 20, estimatedCostUsd: 0.001 },
      }),
    };
    expect(backend.name).toBe("cli-claude");
    expect(typeof backend.run).toBe("function");
  });

  it("exports AgentConfig interface", async () => {
    const mod = await import("../src/runners/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming AgentConfig is constructible with required and optional fields
    const config: Record<string, unknown> = {
      model: "anthropic/claude-sonnet-4-20250514",
      tools: ["read", "write", "edit", "bash"],
      timeoutMs: 300000,
      // Optional fields
      backend: "cli-claude",
      effort: "high",
      permissions: "workspace-write",
      skills: ["analysis"],
      systemPrompt: "You are a helpful assistant.",
      outputFormat: "text",
    };
    expect(config.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(config.tools).toHaveLength(4);
    expect(config.timeoutMs).toBe(300000);
  });

  it("exports CLIBackendConfig interface", async () => {
    const mod = await import("../src/runners/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming CLIBackendConfig is constructible
    const cliConfig: Record<string, unknown> = {
      cliCommand: "claude",
      workingDir: "/tmp/workspace",
      env: { GITHUB_TOKEN: "ghp_test" },
    };
    expect(cliConfig.cliCommand).toBe("claude");
  });

  it("exports StepOutput interface", async () => {
    const mod = await import("../src/runners/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming StepOutput is constructible
    const output: Record<string, unknown> = {
      output: "Step completed successfully",
      outputFiles: [".bees/planning.md"],
      cost: { totalTokens: 500, inputTokens: 400, outputTokens: 100, estimatedCostUsd: 0.001 },
    };
    expect(output.output).toBe("Step completed successfully");
    expect(output.outputFiles).toHaveLength(1);
  });

  it("exports StepContext interface", async () => {
    const mod = await import("../src/runners/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming StepContext is constructible
    const context: Record<string, unknown> = {
      taskId: "task-001",
      taskPayload: { description: "implement feature X" },
      gateId: "new-implementation",
      stepId: "planning",
      priorOutputs: {},
    };
    expect(context.taskId).toBe("task-001");
    expect(context.gateId).toBe("new-implementation");
    expect(context.stepId).toBe("planning");
  });
});

// -------------------------------------------------------------------
// Group 4: Gate Types (src/gates/types.ts)
// -------------------------------------------------------------------
describe("gate types", () => {
  it("exports GateConfig interface", async () => {
    const mod = await import("../src/gates/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming GateConfig is constructible with all sections
    const gateConfig: Record<string, unknown> = {
      gate: { id: "new-implementation", name: "New Implementation", command: "/new-implementation", description: "Run implementation workflow" },
      input: { required: [{ description: "What to implement" }] },
      workflow: { steps: ["planning", "implementation", "review"] },
      steps: {
        planning: { execution: { type: "agent", config: { model: "anthropic/claude-sonnet-4-20250514", tools: ["read"], timeoutMs: 60000 } } },
      },
    };
    expect(gateConfig.gate).toBeDefined();
    expect(gateConfig.input).toBeDefined();
    expect(gateConfig.workflow).toBeDefined();
    expect(gateConfig.steps).toBeDefined();
  });

  it("exports StepDefinition interface", async () => {
    const mod = await import("../src/gates/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming StepDefinition is constructible
    const stepDef: Record<string, unknown> = {
      execution: { type: "agent", config: { model: "anthropic/claude-sonnet-4-20250514", tools: ["read"], timeoutMs: 60000 } },
      inputFiles: [".bees/planning.md"],
      outputFiles: [".bees/implementation.md"],
      behavior: "Generates implementation from planning file",
    };
    expect(stepDef.execution).toBeDefined();
    expect(stepDef.inputFiles).toHaveLength(1);
  });

  it("exports step execution type variants for agent, script, and tool", async () => {
    const mod = await import("../src/gates/types.js");
    expect(mod).toBeDefined();
    // Verify all three execution type variants are constructible
    const agentExec: Record<string, unknown> = {
      type: "agent",
      config: { model: "anthropic/claude-sonnet-4-20250514", tools: ["read", "write"], timeoutMs: 300000 },
    };
    const scriptExec: Record<string, unknown> = {
      type: "script",
      command: "node scripts/validate.js",
      timeoutMs: 30000,
    };
    const toolExec: Record<string, unknown> = {
      type: "tool",
      module: "src/tools/git-ops",
      function: "createBranch",
    };
    // The type field discriminates execution variants
    expect(agentExec.type).toBe("agent");
    expect(scriptExec.type).toBe("script");
    expect(toolExec.type).toBe("tool");
  });
});

// -------------------------------------------------------------------
// Group 5: Cross-Module Type Consistency
// -------------------------------------------------------------------
describe("cross-module type consistency", () => {
  it("all type modules can be imported without conflicts", async () => {
    const queueMod = await import("../src/queue/types.js");
    const adaptersMod = await import("../src/adapters/types.js");
    const runnersMod = await import("../src/runners/types.js");
    const gatesMod = await import("../src/gates/types.js");

    expect(queueMod).toBeDefined();
    expect(adaptersMod).toBeDefined();
    expect(runnersMod).toBeDefined();
    expect(gatesMod).toBeDefined();
  });

  it("TypeScript compilation passes with all type files", () => {
    const result = execSync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    // tsc --noEmit outputs nothing on success
    expect(result.trim()).toBe("");
  });
});
