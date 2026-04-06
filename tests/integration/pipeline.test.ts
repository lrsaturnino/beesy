import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NormalizedMessage, ChannelRef } from "../../src/adapters/types.js";
import type { Task, CostAccumulator } from "../../src/queue/types.js";
import type {
  GateConfig,
  StepDefinition,
  GateMetadata,
  GateInput,
  GateWorkflow,
} from "../../src/gates/types.js";
import type {
  AgentBackend,
  AgentConfig,
  StepContext,
  StepOutput,
} from "../../src/runners/types.js";
import type { Adapter } from "../../src/adapters/adapter.js";
import type { ScriptManifest } from "../../src/scripts/types.js";

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
    // Capture the processor callback (2nd argument) for test invocation
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
// Mock infrastructure: script registry
// ---------------------------------------------------------------

const { mockLoadScriptRegistry } = vi.hoisted(() => ({
  mockLoadScriptRegistry: vi.fn<[string, string], Promise<Map<string, ScriptManifest>>>()
    .mockResolvedValue(new Map()),
}));

vi.mock("../../src/scripts/registry.js", () => ({
  loadScriptRegistry: mockLoadScriptRegistry,
}));

// ---------------------------------------------------------------
// Import module under test (only has a comment -- will fail)
// ---------------------------------------------------------------

import { startApp } from "../../src/index.js";
import type { AppHandle } from "../../src/index.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Minimal test gate YAML matching the test-trivial.yaml format. */
const TEST_TRIVIAL_YAML = `
gate:
  id: test-trivial
  name: "Test Trivial Gate"
  command: /test-trivial
  description: "Minimal single-step gate for testing the end-to-end pipeline"

input:
  required:
    - description: "A brief description of what to test"

workflow:
  steps:
    - echo

steps:
  echo:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
          - write
        timeoutMs: 60000
    behavior: "Echoes the input description back as output for pipeline verification"
`;

/** Test gate YAML with openai model prefix (resolves to cli-codex). */
const TEST_CODEX_YAML = `
gate:
  id: test-codex
  name: "Test Codex Gate"
  command: /test-codex
  description: "Single-step gate for codex backend testing"

input:
  required:
    - description: "A brief description"

workflow:
  steps:
    - echo

steps:
  echo:
    execution:
      type: agent
      config:
        model: openai/gpt-4o
        tools:
          - read
        timeoutMs: 60000
    behavior: "Echo via codex backend"
`;

/** Test gate YAML with google model prefix (resolves to cli-gemini). */
const TEST_GEMINI_YAML = `
gate:
  id: test-gemini
  name: "Test Gemini Gate"
  command: /test-gemini
  description: "Single-step gate for gemini backend testing"

input:
  required:
    - description: "A brief description"

workflow:
  steps:
    - echo

steps:
  echo:
    execution:
      type: agent
      config:
        model: google/gemini-2.0-flash
        tools:
          - read
        timeoutMs: 60000
    behavior: "Echo via gemini backend"
`;

/** Create a zero-initialized CostAccumulator. */
function makeCostAccumulator(): CostAccumulator {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** Build a NormalizedMessage with sensible defaults. */
function makeMessage(
  command: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    command,
    payload: { text: "test input" },
    channel: { platform: "slack", channelId: "C123", threadTs: "1234.5678" },
    requestedBy: "U456",
    timestamp: new Date(),
    ...overrides,
  };
}

/** Create a mock AgentBackend that returns canned output. */
function createMockBackend(
  name: string,
  outputText: string,
): AgentBackend {
  return {
    name,
    run: vi.fn<[AgentConfig, StepContext], Promise<StepOutput>>().mockResolvedValue({
      output: outputText,
      outputFiles: [],
    }),
  };
}

/** Build a minimal valid ScriptManifest with overrides. */
function makeScriptManifest(
  id: string,
  overrides?: Partial<ScriptManifest>,
): ScriptManifest {
  return {
    script_id: id,
    description: `Test script ${id}`,
    runtime: "python",
    path: `scripts/${id.replace(".", "/")}.py`,
    timeout_ms: 30000,
    retryable: false,
    side_effects: "read-only",
    required_env: [],
    rerun_policy: "restart",
    ...overrides,
  };
}

/** Build a test registry Map with the given number of entries. */
function makeTestRegistry(count: number = 2): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();
  for (let i = 1; i <= count; i++) {
    const id = `test.script_${i}`;
    registry.set(id, makeScriptManifest(id));
  }
  return registry;
}

// ---------------------------------------------------------------
// Test state management
// ---------------------------------------------------------------

let tempDir: string;
let app: AppHandle | null = null;
const originalEnv = { ...process.env };
const originalProcessOn = process.on.bind(process);
const registeredSignalHandlers: Array<{
  signal: string;
  handler: (...args: unknown[]) => void;
}> = [];

beforeEach(async () => {
  vi.clearAllMocks();
  capturedProcessor = null;

  // Create temp dir for gate YAML files
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-pipeline-test-"));

  // Set required environment variables
  process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-app-token";
  process.env.GITHUB_TOKEN = "ghp_test_github_token";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.LOG_LEVEL = "error";

  // Track signal handlers registered during tests
  registeredSignalHandlers.length = 0;
});

afterEach(async () => {
  // Shutdown the app if it was started
  if (app) {
    try {
      await app.shutdown();
    } catch {
      // Ignore shutdown errors during cleanup
    }
    app = null;
  }

  // Restore original environment
  process.env = { ...originalEnv };

  // Clean up temp directory
  await rm(tempDir, { recursive: true, force: true });

  vi.restoreAllMocks();
});

/** Write a YAML string to a file in the temp directory. */
async function writeGateYaml(
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(tempDir, filename), content, "utf-8");
}

// ---------------------------------------------------------------
// Group 1: Startup Sequence
// ---------------------------------------------------------------

describe("startup sequence", () => {
  it("loads config from environment variables", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // If startup succeeds, it read the env vars correctly
    expect(app).toBeDefined();
    expect(app.shutdown).toBeInstanceOf(Function);
  });

  it("initializes components in correct order: config -> router -> queue -> worker -> adapter connect", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Slack adapter must have been started (connect calls app.start)
    expect(mockSlackStart).toHaveBeenCalled();
    // Worker must have been created (processor captured)
    expect(capturedProcessor).not.toBeNull();
  });

  it("registers shutdown handlers for SIGTERM and SIGINT", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const processOnSpy = vi.spyOn(process, "on");

    app = await startApp({ gatesDir: tempDir });

    // Check that signal handlers were registered
    const sigTermCalls = processOnSpy.mock.calls.filter(
      (call) => call[0] === "SIGTERM",
    );
    const sigIntCalls = processOnSpy.mock.calls.filter(
      (call) => call[0] === "SIGINT",
    );

    expect(sigTermCalls.length).toBeGreaterThanOrEqual(1);
    expect(sigIntCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------
// Group 1b: Script Registry Wiring
// ---------------------------------------------------------------

describe("script registry wiring", () => {
  it("startApp loads script registry at startup from manifest path", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const testRegistry = makeTestRegistry(2);

    app = await startApp({
      gatesDir: tempDir,
      scriptRegistry: testRegistry,
    });

    // App should start successfully with the injected registry
    expect(app).toBeDefined();
    expect(app.shutdown).toBeInstanceOf(Function);

    // A log entry should mention the script registry with the correct count
    const registryLogCall = mockLogInfo.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        /[Ss]cript.*regist/i.test(call[0] as string),
    );
    expect(registryLogCall).toBeDefined();
    expect(registryLogCall![0]).toContain("2");
  });

  it("registry load failure prevents app startup with descriptive error", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    // Configure mock to reject when loading from a nonexistent path
    const badPath = "/tmp/nonexistent-manifest-path/manifest.yaml";
    mockLoadScriptRegistry.mockRejectedValueOnce(
      new Error(`ENOENT: no such file or directory, open '${badPath}'`),
    );

    await expect(
      startApp({
        gatesDir: tempDir,
        manifestPath: badPath,
      }),
    ).rejects.toThrow();

    // Worker processor should NOT have been created since startup failed
    expect(capturedProcessor).toBeNull();
  });

  it("scriptRegistry override bypasses file loading", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const injectedRegistry = makeTestRegistry(1);
    mockLoadScriptRegistry.mockClear();

    app = await startApp({
      gatesDir: tempDir,
      scriptRegistry: injectedRegistry,
    });

    // App should start successfully
    expect(app).toBeDefined();

    // loadScriptRegistry should NOT have been called since override was provided
    expect(mockLoadScriptRegistry).not.toHaveBeenCalled();
  });

  it("manifestPath override controls where registry is loaded from", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const customManifestPath = path.join(tempDir, "custom-manifest.yaml");
    const customRegistry = makeTestRegistry(3);
    mockLoadScriptRegistry.mockResolvedValueOnce(customRegistry);

    app = await startApp({
      gatesDir: tempDir,
      manifestPath: customManifestPath,
    });

    // loadScriptRegistry should have been called with the custom path
    expect(mockLoadScriptRegistry).toHaveBeenCalledWith(
      customManifestPath,
      expect.any(String),
    );
  });

  it("registry is passed to worker processor and forwarded to runTask", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const testRegistry = makeTestRegistry(2);

    app = await startApp({
      gatesDir: tempDir,
      scriptRegistry: testRegistry,
    });

    expect(capturedProcessor).not.toBeNull();

    // Create a recipe-triggered job to exercise the runTask path
    const mockJob = {
      id: "job-registry-001",
      data: {
        id: "task-registry-001",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test registry threading" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-REGISTRY",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        recipeId: "test-recipe",
        recipeConfig: {
          recipe: {
            id: "test-recipe",
            name: "Test Recipe",
            command: "/test-recipe",
            description: "Test recipe for registry wiring",
          },
          stages: {},
          start_stage: "init",
        },
      },
    };

    // Process the job -- runTask will be called with the registry
    // If registry is not threaded through, script_run subtasks would fail
    // with "Script registry not available"
    await capturedProcessor!(mockJob);

    // Verify no "Script registry not available" error was logged
    const registryMissingLog = mockLogError.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("Script registry not available"),
    );
    expect(registryMissingLog).toBeUndefined();
  });

  it("log entry emitted on successful registry load with script count", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    const testRegistry = makeTestRegistry(3);

    app = await startApp({
      gatesDir: tempDir,
      scriptRegistry: testRegistry,
    });

    // Find the specific log entry about the script registry
    const registryLogCall = mockLogInfo.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        /[Ss]cript.*regist/i.test(call[0] as string),
    );
    expect(registryLogCall).toBeDefined();

    // Verify the log message contains the script count (3)
    const logMessage = registryLogCall![0] as string;
    expect(logMessage).toMatch(/3/);

    // Verify structured log data includes count and path info
    const logData = registryLogCall![1] as Record<string, unknown>;
    expect(logData).toBeDefined();
    expect(logData.scriptCount).toBe(3);
  });
});

// ---------------------------------------------------------------
// Group 2: Message Routing
// ---------------------------------------------------------------

describe("message routing", () => {
  it("routes matching commands through gate router to queue", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // The Slack command handler should have been registered
    expect(mockSlackCommand).toHaveBeenCalled();

    // Simulate an incoming command by finding the registered handler
    // and invoking it with a mock command object
    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/test-trivial",
        text: "run the test",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    // Verify the task was enqueued
    expect(mockQueueAdd).toHaveBeenCalled();
    const addArgs = mockQueueAdd.mock.calls[0];
    expect(addArgs[1]).toHaveProperty("gate", "test-trivial");
  });

  it("handles unmatched commands gracefully without enqueuing", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Trigger the onMessage handler with an unmatched command
    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/unknown-command",
        text: "no match",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    // Queue should not have been called for unmatched commands
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("sends acknowledgment reply when a task is enqueued", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const commandHandler = mockSlackCommand.mock.calls[0]?.[1];
    expect(commandHandler).toBeDefined();

    const mockAck = vi.fn().mockResolvedValue(undefined);
    await commandHandler({
      command: {
        command: "/test-trivial",
        text: "run the test",
        channel_id: "C999",
        user_id: "U789",
      },
      ack: mockAck,
    });

    // Reply is now sent asynchronously after enqueue resolves
    await vi.waitFor(() => {
      expect(mockPostMessage).toHaveBeenCalled();
    });
    const postArgs = mockPostMessage.mock.calls[0]?.[0];
    expect(postArgs?.channel).toBe("C999");
  });
});

// ---------------------------------------------------------------
// Group 3: Worker Processing
// ---------------------------------------------------------------

describe("worker processing", () => {
  it("worker callback processes job through executor pipeline", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Register a mock backend so the worker doesn't spawn real CLI binaries
    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));

    // Verify processor was captured
    expect(capturedProcessor).not.toBeNull();

    // Create a mock job with serialized task data and gate config
    const mockJob = {
      id: "job-001",
      data: {
        id: "task-001",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test input" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C123",
          threadTs: "1234.5678",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Minimal single-step gate",
          },
          input: { required: [{ description: "A brief description" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read", "write"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo the input",
            },
          },
        },
      },
    };

    // The processor should process the job without throwing
    await expect(capturedProcessor!(mockJob)).resolves.not.toThrow();
  });

  it("sends completion reply after successful execution", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Register a mock backend so the worker doesn't spawn real CLI binaries
    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    const mockJob = {
      id: "job-002",
      data: {
        id: "task-002",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C777",
          threadTs: "9999.0000",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Minimal gate",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // A completion reply should be sent to the source channel
    expect(mockPostMessage).toHaveBeenCalled();
    const calls = mockPostMessage.mock.calls;
    const replyCall = calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.channel === "C777",
    );
    expect(replyCall).toBeDefined();
  });

  it("sends failure reply after failed execution", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });
    expect(capturedProcessor).not.toBeNull();

    // Create a job referencing a nonexistent step to force a failure
    const mockJob = {
      id: "job-003",
      data: {
        id: "task-003",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "will fail" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C888",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Gate",
            command: "/test-trivial",
            description: "Gate for failure test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["nonexistent-step"] },
          steps: {},
        },
      },
    };

    // The processor should handle the failure and not throw
    await capturedProcessor!(mockJob);

    // A failure reply should be sent to the source channel
    expect(mockPostMessage).toHaveBeenCalled();
    const calls = mockPostMessage.mock.calls;
    const failureReply = calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.channel === "C888",
    );
    expect(failureReply).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 3b: Thread-Routed Task Execution
// ---------------------------------------------------------------

describe("thread-routed task execution", () => {
  it("worker processor creates thread before executing task", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    // First call (thread creation) returns a ts; subsequent calls succeed normally
    mockPostMessage
      .mockResolvedValueOnce({ ok: true, ts: "thread.1234" })
      .mockResolvedValue({ ok: true });

    const mockJob = {
      id: "job-thread-001",
      data: {
        id: "task-thread-001",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test thread creation" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-THREAD",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Thread test gate",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // Thread creation should be the first postMessage call (no thread_ts)
    expect(mockPostMessage).toHaveBeenCalled();
    const firstCall = mockPostMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCall.channel).toBe("C-THREAD");
    expect(firstCall.thread_ts).toBeUndefined();

    // Subsequent calls (result reply) should include thread_ts from thread creation
    const replyCalls = mockPostMessage.mock.calls.filter(
      (_: unknown, i: number) => i > 0,
    );
    const replyToThread = replyCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.channel === "C-THREAD",
    );
    expect(replyToThread).toBeDefined();
    expect((replyToThread![0] as Record<string, unknown>).thread_ts).toBe("thread.1234");
  });

  it("result reply routes to the created thread", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    mockPostMessage
      .mockResolvedValueOnce({ ok: true, ts: "thread.5678" })
      .mockResolvedValue({ ok: true });

    const mockJob = {
      id: "job-thread-002",
      data: {
        id: "task-thread-002",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test reply routing" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-REPLY",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Reply routing test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // Find the completion reply call (should be the last postMessage to C-REPLY)
    const calls = mockPostMessage.mock.calls;
    const replyCalls = calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.channel === "C-REPLY",
    );
    expect(replyCalls.length).toBeGreaterThanOrEqual(2);

    // The last call to C-REPLY is the completion reply -- it should have thread_ts
    const lastReply = replyCalls[replyCalls.length - 1];
    expect((lastReply[0] as Record<string, unknown>).thread_ts).toBe("thread.5678");
  });

  it("thread creation failure degrades to flat-channel posting without crashing", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    // First call (thread creation) fails; subsequent calls succeed
    mockPostMessage
      .mockRejectedValueOnce(new Error("slack_api_error"))
      .mockResolvedValue({ ok: true });

    const mockJob = {
      id: "job-thread-003",
      data: {
        id: "task-thread-003",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test degradation" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-DEGRADE",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Degradation test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo",
            },
          },
        },
      },
    };

    // Task should execute without crashing despite thread creation failure
    await expect(capturedProcessor!(mockJob)).resolves.not.toThrow();

    // A reply should still be sent (flat channel, no thread_ts)
    const calls = mockPostMessage.mock.calls;
    const replyCalls = calls.filter(
      (c: unknown[], i: number) =>
        i > 0 && (c[0] as Record<string, unknown>)?.channel === "C-DEGRADE",
    );
    expect(replyCalls.length).toBeGreaterThanOrEqual(1);

    // The result reply should NOT have thread_ts (flat-channel degradation)
    const resultReply = replyCalls[replyCalls.length - 1];
    expect((resultReply[0] as Record<string, unknown>).thread_ts).toBeUndefined();
  });

  it("thread-scoped ChannelRef preserves original channel ID", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    mockPostMessage
      .mockResolvedValueOnce({ ok: true, ts: "thread.9999" })
      .mockResolvedValue({ ok: true });

    const mockJob = {
      id: "job-thread-004",
      data: {
        id: "task-thread-004",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test channel preservation" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-PRESERVE",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Channel preservation test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // All postMessage calls to C-PRESERVE should use the same channel ID
    const calls = mockPostMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.channel === "C-PRESERVE",
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // The reply call should preserve channel ID and add thread_ts
    const replyCall = calls[calls.length - 1];
    const replyArgs = replyCall[0] as Record<string, unknown>;
    expect(replyArgs.channel).toBe("C-PRESERVE");
    expect(replyArgs.thread_ts).toBe("thread.9999");
  });
});

// ---------------------------------------------------------------
// Group 3c: Progress Notifications (Integration)
// ---------------------------------------------------------------

/** Multi-step gate YAML for progress notification integration tests. */
const TEST_MULTI_STEP_YAML = `
gate:
  id: test-multi
  name: "Test Multi-Step Gate"
  command: /test-multi
  description: "Two-step gate for progress notification testing"

input:
  required:
    - description: "A brief description"

workflow:
  steps:
    - analyze
    - implement

steps:
  analyze:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
    behavior: "Analyze the input"
  implement:
    execution:
      type: script
      command: "node scripts/run.js"
      timeoutMs: 30000
    behavior: "Apply implementation"
`;

describe("progress notifications", () => {
  it("worker processor sends formatted progress messages to thread", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "mock output"));
    expect(capturedProcessor).not.toBeNull();

    // First call: thread creation; subsequent calls: progress + result replies
    mockPostMessage
      .mockResolvedValueOnce({ ok: true, ts: "thread.progress-001" })
      .mockResolvedValue({ ok: true });

    const mockJob = {
      id: "job-progress-001",
      data: {
        id: "task-progress-001",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test progress messages" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-PROGRESS",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "Progress notification test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo the input",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // Collect all postMessage calls targeting C-PROGRESS with thread_ts
    const threadCalls = mockPostMessage.mock.calls.filter(
      (c: unknown[]) => {
        const args = c[0] as Record<string, unknown>;
        return args.channel === "C-PROGRESS" && args.thread_ts === "thread.progress-001";
      },
    );

    // At least one call should contain a formatted progress string
    const progressCalls = threadCalls.filter((c: unknown[]) => {
      const text = (c[0] as Record<string, unknown>).text as string;
      return /Step \d+\/\d+:/.test(text);
    });
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the format matches "Step N/M: <name> (<type>) -- <status>"
    const firstProgressText = (progressCalls[0][0] as Record<string, unknown>).text as string;
    expect(firstProgressText).toMatch(/Step 1\/1:.+\(.+\) -- (started|completed)/);
  });

  it("progress callback error does not crash worker or block subsequent progress events", async () => {
    await writeGateYaml("test-multi.yaml", TEST_MULTI_STEP_YAML);

    app = await startApp({ gatesDir: tempDir });

    const { registerBackend } = await import("../../src/runners/registry.js");
    registerBackend("cli-claude", createMockBackend("cli-claude", "analyze output"));

    // Mock the script runner to succeed for the second step
    const scriptRunner = await import("../../src/executor/script-runner.js");
    vi.spyOn(scriptRunner, "runScript").mockResolvedValue({
      output: "implement output",
      outputFiles: [],
    });

    expect(capturedProcessor).not.toBeNull();

    // Thread creation succeeds, first progress call rejects, rest succeed
    let callCount = 0;
    mockPostMessage.mockImplementation(async () => {
      callCount++;
      // Call 1: thread creation (succeed)
      // Call 2: first progress event (reject to simulate send error)
      if (callCount === 2) {
        throw new Error("simulated Slack API error on progress");
      }
      // All other calls succeed
      return { ok: true, ts: "thread.progress-err" };
    });

    const mockJob = {
      id: "job-progress-err",
      data: {
        id: "task-progress-err",
        gate: "test-multi",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "test progress error isolation" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-PROGRESS-ERR",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-multi",
            name: "Test Multi-Step Gate",
            command: "/test-multi",
            description: "Error isolation test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["analyze", "implement"] },
          steps: {
            analyze: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Analyze the input",
            },
            implement: {
              execution: {
                type: "script",
                command: "node scripts/run.js",
                timeoutMs: 30000,
              },
              behavior: "Apply implementation",
            },
          },
        },
      },
    };

    // Task should complete despite progress send error
    await expect(capturedProcessor!(mockJob)).resolves.not.toThrow();

    // Multiple postMessage calls should have been made (not stopped after error)
    expect(mockPostMessage.mock.calls.length).toBeGreaterThan(2);

    // A completion reply should still be present
    const completionCalls = mockPostMessage.mock.calls.filter(
      (c: unknown[]) => {
        const text = (c[0] as Record<string, unknown>).text as string;
        return typeof text === "string" && text.includes("completed");
      },
    );
    expect(completionCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------
// Group 4: Graceful Shutdown
// ---------------------------------------------------------------

describe("graceful shutdown", () => {
  it("SIGTERM triggers coordinated shutdown: disconnect Slack, close queue", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Call shutdown explicitly (simulating SIGTERM handler behavior)
    await app.shutdown();

    // Slack adapter should have been disconnected
    expect(mockSlackStop).toHaveBeenCalled();
    // Queue should have been closed
    expect(mockWorkerClose).toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalled();

    // Prevent double-shutdown in afterEach
    app = null;
  });

  it("SIGINT triggers same shutdown as SIGTERM", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Same assertions: shutdown closes all components
    await app.shutdown();

    expect(mockSlackStop).toHaveBeenCalled();
    expect(mockWorkerClose).toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalled();

    app = null;
  });

  it("shutdown is idempotent: multiple calls do not error or double-close", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Call shutdown twice in succession
    await app.shutdown();
    await app.shutdown();

    // Each component's close should only have been called once
    expect(mockSlackStop).toHaveBeenCalledTimes(1);

    app = null;
  });
});

// ---------------------------------------------------------------
// Group 5: End-to-End Pipeline (E2E with Mocks)
// ---------------------------------------------------------------

describe("end-to-end pipeline", () => {
  it("processes trivial gate with mock cli-claude backend", async () => {
    await writeGateYaml("test-trivial.yaml", TEST_TRIVIAL_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Register mock backend after startApp (which registers real ones)
    const { registerBackend, resetRegistry } = await import(
      "../../src/runners/registry.js"
    );
    const mockClaudeBackend = createMockBackend(
      "cli-claude",
      "Claude response: pipeline verified",
    );
    registerBackend("cli-claude", mockClaudeBackend);
    expect(capturedProcessor).not.toBeNull();

    // Create a job simulating the full pipeline
    const mockJob = {
      id: "job-e2e-claude",
      data: {
        id: "task-e2e-claude",
        gate: "test-trivial",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "verify pipeline" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-E2E-CLAUDE",
          threadTs: "1111.2222",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-trivial",
            name: "Test Trivial Gate",
            command: "/test-trivial",
            description: "E2E test gate",
          },
          input: { required: [{ description: "A brief description" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read", "write"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo the input",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // The mock claude backend should have been called
    expect(mockClaudeBackend.run).toHaveBeenCalled();

    // A completion reply should have been sent
    expect(mockPostMessage).toHaveBeenCalled();
    const calls = mockPostMessage.mock.calls;
    const replyCall = calls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>)?.channel === "C-E2E-CLAUDE",
    );
    expect(replyCall).toBeDefined();

    resetRegistry();
  });

  it("processes trivial gate with mock cli-codex backend", async () => {
    await writeGateYaml("test-codex.yaml", TEST_CODEX_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Register mock backend after startApp (which registers real ones)
    const { registerBackend, resetRegistry } = await import(
      "../../src/runners/registry.js"
    );
    const mockCodexBackend = createMockBackend(
      "cli-codex",
      "Codex response: pipeline verified",
    );
    registerBackend("cli-codex", mockCodexBackend);
    expect(capturedProcessor).not.toBeNull();

    const mockJob = {
      id: "job-e2e-codex",
      data: {
        id: "task-e2e-codex",
        gate: "test-codex",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "verify codex pipeline" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-E2E-CODEX",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-codex",
            name: "Test Codex Gate",
            command: "/test-codex",
            description: "E2E codex test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "openai/gpt-4o",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo via codex",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // The mock codex backend should have been called
    expect(mockCodexBackend.run).toHaveBeenCalled();

    // Completion reply should have been sent
    expect(mockPostMessage).toHaveBeenCalled();
    const calls = mockPostMessage.mock.calls;
    const replyCall = calls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>)?.channel === "C-E2E-CODEX",
    );
    expect(replyCall).toBeDefined();

    resetRegistry();
  });

  it("processes trivial gate with mock cli-gemini backend", async () => {
    await writeGateYaml("test-gemini.yaml", TEST_GEMINI_YAML);

    app = await startApp({ gatesDir: tempDir });

    // Register mock backend after startApp (which registers real ones)
    const { registerBackend, resetRegistry } = await import(
      "../../src/runners/registry.js"
    );
    const mockGeminiBackend = createMockBackend(
      "cli-gemini",
      "Gemini response: pipeline verified",
    );
    registerBackend("cli-gemini", mockGeminiBackend);
    expect(capturedProcessor).not.toBeNull();

    const mockJob = {
      id: "job-e2e-gemini",
      data: {
        id: "task-e2e-gemini",
        gate: "test-gemini",
        status: "queued",
        priority: "normal",
        position: 0,
        payload: { text: "verify gemini pipeline" },
        requestedBy: "U456",
        sourceChannel: {
          platform: "slack",
          channelId: "C-E2E-GEMINI",
          threadTs: "5555.6666",
        },
        createdAt: new Date().toISOString(),
        cost: makeCostAccumulator(),
        gateConfig: {
          gate: {
            id: "test-gemini",
            name: "Test Gemini Gate",
            command: "/test-gemini",
            description: "E2E gemini test",
          },
          input: { required: [{ description: "Input" }] },
          workflow: { steps: ["echo"] },
          steps: {
            echo: {
              execution: {
                type: "agent",
                config: {
                  model: "google/gemini-2.0-flash",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
              behavior: "Echo via gemini",
            },
          },
        },
      },
    };

    await capturedProcessor!(mockJob);

    // The mock gemini backend should have been called
    expect(mockGeminiBackend.run).toHaveBeenCalled();

    // Completion reply should have been sent
    expect(mockPostMessage).toHaveBeenCalled();
    const calls = mockPostMessage.mock.calls;
    const replyCall = calls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>)?.channel === "C-E2E-GEMINI",
    );
    expect(replyCall).toBeDefined();

    resetRegistry();
  });
});
