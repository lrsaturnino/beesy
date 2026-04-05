import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type { AgentConfig, StepContext } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Logger mock (vi.hoisted pattern from prompt-builder.test.ts)
// ---------------------------------------------------------------

const { mockInfo, mockWarn, mockError } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  }),
  logger: {
    debug: vi.fn(),
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  },
}));

// ---------------------------------------------------------------
// child_process.spawn mock
// ---------------------------------------------------------------

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------
// fs/promises mock
// ---------------------------------------------------------------

const { mockWriteFile, mockReadFile, mockUnlink, mockMkdir, mockRename } =
  vi.hoisted(() => ({
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockResolvedValue(""),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRename: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  mkdir: mockMkdir,
  rename: mockRename,
}));

// ---------------------------------------------------------------
// Import module under test (does not exist yet -- RED phase)
// ---------------------------------------------------------------

import { stripProviderPrefix, CLIAgentBackend } from "../../src/runners/cli-backend.js";

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

/**
 * Create a mock ChildProcess with controllable stdout, stderr, and events.
 *
 * The mock process uses EventEmitter for stdout, stderr, and process-level
 * events. Tests trigger behavior by calling emitStdout, emitStderr, and
 * emitClose on the returned helper object.
 */
function createMockProcess(): {
  process: ChildProcess;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitClose: (code: number | null) => void;
} {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinMock = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };

  Object.defineProperty(proc, "stdout", { value: stdoutEmitter, writable: false });
  Object.defineProperty(proc, "stderr", { value: stderrEmitter, writable: false });
  Object.defineProperty(proc, "stdin", { value: stdinMock, writable: false });
  Object.defineProperty(proc, "kill", { value: vi.fn().mockReturnValue(true), writable: false });
  Object.defineProperty(proc, "pid", { value: 12345, writable: false });

  return {
    process: proc,
    emitStdout: (data: string) => stdoutEmitter.emit("data", Buffer.from(data)),
    emitStderr: (data: string) => stderrEmitter.emit("data", Buffer.from(data)),
    emitClose: (code: number | null) => (proc as unknown as EventEmitter).emit("close", code),
  };
}

/** Configure mockSpawn to return a given mock process. */
function setupSpawnMock(mockProc: ChildProcess): void {
  mockSpawn.mockReturnValue(mockProc);
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  mockSpawn.mockReset();
  mockWriteFile.mockReset().mockResolvedValue(undefined);
  mockReadFile.mockReset().mockResolvedValue("");
  mockUnlink.mockReset().mockResolvedValue(undefined);
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockRename.mockReset().mockResolvedValue(undefined);
  mockInfo.mockClear();
  mockWarn.mockClear();
  mockError.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------
// Group 1: Provider Prefix Stripping
// ---------------------------------------------------------------

describe("provider prefix stripping", () => {
  it("strips anthropic prefix from model ID", () => {
    expect(stripProviderPrefix("anthropic/claude-sonnet-4-20250514")).toBe(
      "claude-sonnet-4-20250514",
    );
  });

  it("strips openai prefix from model ID", () => {
    expect(stripProviderPrefix("openai/gpt-5.4")).toBe("gpt-5.4");
  });

  it("strips google prefix from model ID", () => {
    expect(stripProviderPrefix("google/gemini-3.1-pro-preview")).toBe(
      "gemini-3.1-pro-preview",
    );
  });

  it("handles model ID with multiple slashes", () => {
    expect(stripProviderPrefix("anthropic/claude/experimental")).toBe(
      "claude/experimental",
    );
  });

  it("throws for model ID without provider prefix", () => {
    expect(() => stripProviderPrefix("gpt-4o")).toThrow(/prefix/i);
  });
});

// ---------------------------------------------------------------
// Group 2: Subprocess Spawn and Output Capture
// ---------------------------------------------------------------

describe("subprocess spawn and output capture", () => {
  it("spawns CLI process with correct command and args", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "claude-sonnet-4-20250514", "-p", "/tmp/prompt.md"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const config = makeAgentConfig();
    const context = makeStepContext();

    const runPromise = backend.run(config, context);

    // Simulate process completing
    emitStdout("model output here");
    emitClose(0);

    await runPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "claude-sonnet-4-20250514"]),
      expect.any(Object),
    );
  });

  it("captures stdout as step output", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test", "-p", "/tmp/prompt.md"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("captured ");
    emitStdout("output text");
    emitClose(0);

    const result = await runPromise;
    expect(result.output).toContain("captured ");
    expect(result.output).toContain("output text");
  });

  it("translates exit code 0 to success StepOutput", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("success output");
    emitClose(0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("translates non-zero exit code to failure StepOutput", async () => {
    const { process: mockProc, emitStderr, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStderr("something went wrong");
    emitClose(1);

    const result = await runPromise;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("captures stderr content in error field on failure", async () => {
    const { process: mockProc, emitStderr, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStderr("diagnostic info: segfault at 0x0");
    emitClose(2);

    const result = await runPromise;
    expect(result.error).toContain("diagnostic info");
    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------
// Group 3: Timeout Enforcement
// ---------------------------------------------------------------

describe("timeout enforcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills process after configured timeoutMs", async () => {
    const { process: mockProc, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const config = makeAgentConfig({ timeoutMs: 5000 });

    const runPromise = backend.run(config, makeStepContext());

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(5001);

    // After kill, the process close event fires
    emitClose(null);

    const result = await runPromise;
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it("returns timeout-specific error in StepOutput", async () => {
    const { process: mockProc, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const config = makeAgentConfig({ timeoutMs: 3000 });

    const runPromise = backend.run(config, makeStepContext());

    await vi.advanceTimersByTimeAsync(3001);
    emitClose(null);

    const result = await runPromise;
    expect(result.error).toMatch(/timeout/i);
  });

  it("clears timeout when process exits normally before timeout", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const config = makeAgentConfig({ timeoutMs: 60000 });

    const runPromise = backend.run(config, makeStepContext());

    // Process exits normally before timeout
    emitStdout("done");
    emitClose(0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(mockProc.kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Group 4: State Flag Lifecycle
// ---------------------------------------------------------------

describe("state flag lifecycle", () => {
  it("creates pending state flag before spawn", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    // Verify a pending flag file was created
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("pending"),
      expect.any(String),
      expect.any(String),
    );
  });

  it("transitions to completed flag on success", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    // Verify completed flag was created (rename or unlink+write)
    const allWriteCalls = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]));
    const allRenameCalls = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));
    const allUnlinkCalls = mockUnlink.mock.calls.map((c: unknown[]) => String(c[0]));

    const hasCompleted =
      allWriteCalls.some((p: string) => p.includes("completed")) ||
      allRenameCalls.some((p: string) => p.includes("completed"));

    expect(hasCompleted).toBe(true);
  });

  it("transitions to failed flag on failure", async () => {
    const { process: mockProc, emitStderr, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStderr("error");
    emitClose(1);
    await runPromise;

    const allWriteCalls = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]));
    const allRenameCalls = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasFailed =
      allWriteCalls.some((p: string) => p.includes("failed")) ||
      allRenameCalls.some((p: string) => p.includes("failed"));

    expect(hasFailed).toBe(true);
  });

  it("transitions to failed flag on timeout", async () => {
    vi.useFakeTimers();

    const { process: mockProc, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const config = makeAgentConfig({ timeoutMs: 2000 });

    const runPromise = backend.run(config, makeStepContext());

    await vi.advanceTimersByTimeAsync(2001);
    emitClose(null);

    await runPromise;

    const allWriteCalls = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]));
    const allRenameCalls = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasFailed =
      allWriteCalls.some((p: string) => p.includes("failed")) ||
      allRenameCalls.some((p: string) => p.includes("failed"));

    expect(hasFailed).toBe(true);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------
// Group 5: Prompt File Writing
// ---------------------------------------------------------------

describe("prompt file writing", () => {
  it("writes prompt content to temp file before spawning", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockReturnValue(["--model", "test", "-p", "/tmp/prompt.md"]),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const context = makeStepContext();

    const runPromise = backend.run(makeAgentConfig(), context);

    emitStdout("output");
    emitClose(0);
    await runPromise;

    // writeFile should have been called for the prompt file before spawn
    const writeCallArgs = mockWriteFile.mock.calls;
    expect(writeCallArgs.length).toBeGreaterThan(0);
  });

  it("passes temp file path to CLI command arguments", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    setupSpawnMock(mockProc);

    const capturedArgs: string[] = [];
    const adapter = {
      cliCommand: "claude",
      buildArgs: vi.fn().mockImplementation(
        (_config: AgentConfig, promptFilePath: string) => {
          capturedArgs.push(promptFilePath);
          return ["--model", "test", "-p", promptFilePath];
        },
      ),
      captureMode: "stdout" as const,
    };

    const backend = new CLIAgentBackend("cli-claude", adapter);
    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    // The adapter's buildArgs should have been called with a prompt file path
    expect(adapter.buildArgs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("prompt"),
      expect.anything(),
    );
  });
});
