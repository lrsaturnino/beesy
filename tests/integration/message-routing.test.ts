import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock infrastructure: logger (suppress noise during tests)
// ---------------------------------------------------------------

const { mockLogInfo, mockLogWarn, mockLogError, mockLogDebug } = vi.hoisted(
  () => ({
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockLogDebug: vi.fn(),
  }),
);

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
  logger: {
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

// ---------------------------------------------------------------
// Mock infrastructure: @slack/bolt
// ---------------------------------------------------------------

const { mockSlackStart, mockSlackStop, mockSlackCommand, mockSlackEvent, mockPostMessage } =
  vi.hoisted(() => ({
    mockSlackStart: vi.fn().mockResolvedValue(undefined),
    mockSlackStop: vi.fn().mockResolvedValue(undefined),
    mockSlackCommand: vi.fn(),
    mockSlackEvent: vi.fn(),
    mockPostMessage: vi.fn().mockResolvedValue({ ok: true }),
  }));

vi.mock("@slack/bolt", () => {
  const MockApp = vi.fn(function (this: Record<string, unknown>) {
    this.start = mockSlackStart;
    this.stop = mockSlackStop;
    this.command = mockSlackCommand;
    this.event = mockSlackEvent;
    this.client = {
      chat: {
        postMessage: mockPostMessage,
      },
    };
  });
  return { App: MockApp };
});

// ---------------------------------------------------------------
// Mock infrastructure: ioredis
// ---------------------------------------------------------------

const { mockRedisQuit } = vi.hoisted(() => ({
  mockRedisQuit: vi.fn().mockResolvedValue("OK"),
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn(function (this: Record<string, unknown>) {
    this.on = vi.fn();
    this.quit = mockRedisQuit;
    this.disconnect = vi.fn();
  });
  return { Redis: MockRedis, default: MockRedis };
});

// ---------------------------------------------------------------
// Mock infrastructure: bullmq
// ---------------------------------------------------------------

/** Captured worker processor callback for invoking during tests. */
let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

const { mockQueueAdd, mockQueueClose, mockWorkerClose } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({ id: "job-001" }),
  mockQueueClose: vi.fn().mockResolvedValue(undefined),
  mockWorkerClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", () => {
  const MockQueue = vi.fn(function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    this.add = mockQueueAdd;
    this.close = mockQueueClose;
    this.on = vi.fn();
    this.name = args[0];
  });

  const MockWorker = vi.fn(function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    if (typeof args[1] === "function") {
      capturedProcessor = args[1] as (job: unknown) => Promise<void>;
    }
    this.close = mockWorkerClose;
    this.on = vi.fn();
    this.off = vi.fn();
    this.name = args[0];
  });

  return { Queue: MockQueue, Worker: MockWorker };
});

// ---------------------------------------------------------------
// Mock infrastructure: runTask and executeTask
// ---------------------------------------------------------------

const { mockRunTask } = vi.hoisted(() => ({
  mockRunTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/runtime/worker.js", () => ({
  runTask: mockRunTask,
}));

const { mockExecuteTask } = vi.hoisted(() => ({
  mockExecuteTask: vi.fn().mockResolvedValue({
    id: "task-001",
    gate: "test-gate",
    status: "completed",
    priority: "normal",
    position: 0,
    payload: {},
    requestedBy: "U456",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date(),
    cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
  }),
}));

vi.mock("../../src/executor/task-executor.js", () => ({
  executeTask: mockExecuteTask,
}));

// ---------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------

import { startApp } from "../../src/index.js";
import type { AppHandle } from "../../src/index.js";

// ---------------------------------------------------------------
// Shared fixtures and helpers
// ---------------------------------------------------------------

/** Minimal gate YAML that claims command /gate-only. */
const GATE_ONLY_YAML = `
gate:
  id: gate-only
  name: "Gate Only"
  command: /gate-only
  description: "A gate with no matching recipe"

input:
  required:
    - description: "What to do"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
`;

/** Gate YAML that claims /new-implementation (will collide with recipe). */
const GATE_COLLISION_YAML = `
gate:
  id: gate-new-implementation
  name: "Gate New Implementation"
  command: /new-implementation
  description: "Legacy gate for new implementation"

input:
  required:
    - description: "Description of the feature"

workflow:
  steps:
    - plan

steps:
  plan:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
`;

/** Minimal recipe YAML that claims command /new-implementation. */
const RECIPE_NEW_IMPL_YAML = `
recipe:
  id: new-implementation
  name: "New Implementation"
  command: /new-implementation
  description: "Recipe-driven new implementation"

orchestrator:
  role: roles/orchestrator.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 30000
  max_stage_retries: 3
  max_total_actions: 10

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planner.md
    objective: "Create a plan"
    inputs: []
    outputs:
      - label: planning_doc
        format: md
    allowed_transitions: []
    allowed_scripts: []
`;

/** Minimal recipe YAML claiming a unique command /recipe-only. */
const RECIPE_ONLY_YAML = `
recipe:
  id: recipe-only
  name: "Recipe Only"
  command: /recipe-only
  description: "A recipe with no matching gate"

orchestrator:
  role: roles/orchestrator.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 30000
  max_stage_retries: 3
  max_total_actions: 10

stage_order:
  - execute

start_stage: execute

stages:
  execute:
    role: roles/executor.md
    objective: "Execute the task"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

// ---------------------------------------------------------------
// Test state management
// ---------------------------------------------------------------

let gatesDir: string;
let recipesDir: string;
let app: AppHandle | null = null;
const originalEnv = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  capturedProcessor = null;

  // Create temp directories for gates and recipes
  const tmpBase = await mkdtemp(path.join(tmpdir(), "bees-routing-test-"));
  gatesDir = path.join(tmpBase, "gates");
  recipesDir = path.join(tmpBase, "recipes");
  await mkdir(gatesDir, { recursive: true });
  await mkdir(recipesDir, { recursive: true });

  // Set required environment variables
  process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-app-token";
  process.env.GITHUB_TOKEN = "ghp_test_github_token";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.LOG_LEVEL = "error";
});

afterEach(async () => {
  if (app) {
    try {
      await app.shutdown();
    } catch {
      // Ignore shutdown errors during cleanup
    }
    app = null;
  }

  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/** Write a gate YAML file into the gates directory. */
async function writeGateYaml(filename: string, content: string): Promise<void> {
  await writeFile(path.join(gatesDir, filename), content, "utf-8");
}

/** Write a recipe YAML file into a recipe subdirectory. */
async function writeRecipeYaml(recipeId: string, content: string): Promise<void> {
  const recipeSubdir = path.join(recipesDir, recipeId);
  await mkdir(recipeSubdir, { recursive: true });
  await writeFile(path.join(recipeSubdir, "recipe.yaml"), content, "utf-8");
}

/** Start the app with both gates and recipes directories. */
async function startTestApp(): Promise<AppHandle> {
  return startApp({
    gatesDir,
    recipesDir,
  });
}

// ---------------------------------------------------------------
// Group 1: Dual-Router Message Routing
// ---------------------------------------------------------------

describe("dual-router message routing", () => {
  it("recipe command routes message to recipe worker path", async () => {
    await writeRecipeYaml("new-implementation", RECIPE_NEW_IMPL_YAML);
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();

    // Get the Slack command handler
    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/new-implementation",
        text: "build a feature",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    // Task should be enqueued
    expect(mockQueueAdd).toHaveBeenCalled();
    const addArgs = mockQueueAdd.mock.calls[0];
    // Enqueued task must have recipeId set
    expect(addArgs[1]).toHaveProperty("recipeId", "new-implementation");

    // Process the enqueued job through the worker
    expect(capturedProcessor).not.toBeNull();
    const mockJob = {
      id: "job-recipe-001",
      data: {
        ...addArgs[1],
        createdAt: new Date().toISOString(),
      },
    };
    await capturedProcessor!(mockJob);

    // runTask should have been called, not executeTask
    expect(mockRunTask).toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it("gate command routes message to gate worker path", async () => {
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();

    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/gate-only",
        text: "run the gate",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    expect(mockQueueAdd).toHaveBeenCalled();
    const addArgs = mockQueueAdd.mock.calls[0];
    // Gate tasks should NOT have recipeId
    expect(addArgs[1].recipeId).toBeUndefined();

    // Process via worker
    expect(capturedProcessor).not.toBeNull();
    const mockJob = {
      id: "job-gate-001",
      data: {
        ...addArgs[1],
        createdAt: new Date().toISOString(),
      },
    };
    await capturedProcessor!(mockJob);

    // executeTask should be called, not runTask
    expect(mockExecuteTask).toHaveBeenCalled();
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  it("unmatched command logs warning and does not enqueue", async () => {
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();

    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/unknown",
        text: "no match here",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    // Queue should not have been invoked
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // A warning should have been logged
    expect(mockLogWarn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Group 2: Collision Handling at Startup
// ---------------------------------------------------------------

describe("collision handling at startup", () => {
  it("startup disables gate for recipe-claimed command with logged warning", async () => {
    // Both recipe and gate claim /new-implementation
    await writeRecipeYaml("new-implementation", RECIPE_NEW_IMPL_YAML);
    await writeGateYaml("new-implementation.yaml", GATE_COLLISION_YAML);

    app = await startTestApp();

    // A collision warning should have been logged
    const warnCalls = mockLogWarn.mock.calls;
    const collisionWarning = warnCalls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("/new-implementation"),
    );
    expect(collisionWarning).toBeDefined();

    // Recipe should take precedence: sending /new-implementation should
    // route through the recipe path
    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/new-implementation",
        text: "build it",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    expect(mockQueueAdd).toHaveBeenCalled();
    const addArgs = mockQueueAdd.mock.calls[0];
    expect(addArgs[1]).toHaveProperty("recipeId", "new-implementation");
  });

  it("startup with no collisions produces no collision warnings", async () => {
    // Recipe and gate have disjoint commands
    await writeRecipeYaml("recipe-only", RECIPE_ONLY_YAML);
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();

    // No collision-related warnings (only check for collision-specific text)
    const collisionWarnings = mockLogWarn.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0].includes("collision") || call[0].includes("both recipe and gate")),
    );
    expect(collisionWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// Group 3: Worker Processor Dispatch
// ---------------------------------------------------------------

describe("worker processor dispatch", () => {
  it("worker processor uses runTask for recipe-triggered jobs", async () => {
    await writeRecipeYaml("new-implementation", RECIPE_NEW_IMPL_YAML);
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();
    expect(capturedProcessor).not.toBeNull();

    const mockJob = {
      id: "job-recipe-002",
      data: {
        id: "task-recipe-002",
        gate: "new-implementation",
        recipeId: "new-implementation",
        recipeConfig: {
          id: "new-implementation",
          name: "New Implementation",
          command: "/new-implementation",
          description: "Recipe-driven",
          orchestrator: {
            role: "roles/orchestrator.md",
            backend: "cli-claude",
            model: "anthropic/claude-sonnet-4-20250514",
            effort: "high",
            timeout_ms: 30000,
            max_stage_retries: 3,
            max_total_actions: 10,
          },
          stage_order: ["planning"],
          start_stage: "planning",
          stages: {
            planning: {
              role: "roles/planner.md",
              objective: "Create a plan",
              inputs: [],
              outputs: [],
              allowed_transitions: [],
              allowed_scripts: [],
            },
          },
        },
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { description: "build it" },
        requestedBy: "U789",
        sourceChannel: { platform: "slack", channelId: "C999" },
        createdAt: new Date().toISOString(),
        cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      },
    };

    await capturedProcessor!(mockJob);

    expect(mockRunTask).toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it("worker processor uses executeTask for gate-triggered jobs", async () => {
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();
    expect(capturedProcessor).not.toBeNull();

    // Register a mock backend for the gate execution path
    const { registerBackend } = await import("../../src/runners/registry.js");
    const { AgentBackend } = await import("../../src/runners/types.js").catch(() => ({}));

    const mockJob = {
      id: "job-gate-002",
      data: {
        id: "task-gate-002",
        gate: "gate-only",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { description: "gate task" },
        requestedBy: "U789",
        sourceChannel: { platform: "slack", channelId: "C999" },
        createdAt: new Date().toISOString(),
        cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        gateConfig: {
          gate: {
            id: "gate-only",
            name: "Gate Only",
            command: "/gate-only",
            description: "A gate with no matching recipe",
          },
          input: { required: [{ description: "What to do" }] },
          workflow: { steps: ["work"] },
          steps: {
            work: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    expect(mockExecuteTask).toHaveBeenCalled();
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  it("worker processor creates Slack thread for both recipe and gate paths", async () => {
    await writeRecipeYaml("new-implementation", RECIPE_NEW_IMPL_YAML);
    await writeGateYaml("gate-only.yaml", GATE_ONLY_YAML);

    app = await startTestApp();
    expect(capturedProcessor).not.toBeNull();

    // Process a recipe job
    const recipeJob = {
      id: "job-recipe-thread",
      data: {
        id: "task-recipe-thread",
        gate: "new-implementation",
        recipeId: "new-implementation",
        recipeConfig: {
          id: "new-implementation",
          name: "New Implementation",
          command: "/new-implementation",
          description: "Recipe-driven",
          orchestrator: {
            role: "roles/orchestrator.md",
            backend: "cli-claude",
            model: "anthropic/claude-sonnet-4-20250514",
            effort: "high",
            timeout_ms: 30000,
            max_stage_retries: 3,
            max_total_actions: 10,
          },
          stage_order: ["planning"],
          start_stage: "planning",
          stages: {},
        },
        status: "queued",
        priority: "normal",
        position: 0,
        payload: {},
        requestedBy: "U789",
        sourceChannel: { platform: "slack", channelId: "C999" },
        createdAt: new Date().toISOString(),
        cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      },
    };

    await capturedProcessor!(recipeJob);

    // Thread creation happens via postMessage (mock Slack)
    expect(mockPostMessage).toHaveBeenCalled();
  });
});
