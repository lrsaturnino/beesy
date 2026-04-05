import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

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

import { GeminiCLIBackend } from "../../src/runners/cli-gemini.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create AgentConfig with Gemini-specific defaults and optional overrides. */
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "google/gemini-2.5-pro",
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

/** Create a mock ChildProcess with controllable stdout, stderr, and events. */
function createMockProcess(): {
  process: ChildProcess;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitClose: (code: number | null) => void;
} {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinMock = { write: vi.fn(), end: vi.fn(), on: vi.fn() };

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

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

let backend: InstanceType<typeof GeminiCLIBackend>;

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

  backend = new GeminiCLIBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Command Construction
// ---------------------------------------------------------------

describe("command construction", () => {
  it("constructs gemini command with --model flag using stripped model ID", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ model: "google/gemini-2.5-pro" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const command: string = spawnCall[0];
    const args: string[] = spawnCall[1];

    expect(command).toBe("gemini");

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("gemini-2.5-pro");
  });

  it("includes --approval-mode=yolo flag always", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--approval-mode=yolo");
  });

  it("includes --output-format flag when outputFormat is configured", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ outputFormat: "text" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    const fmtIdx = args.indexOf("--output-format");

    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(args[fmtIdx + 1]).toBe("text");
  });

  it("includes -p flag with prompt file path", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("-p");
  });

  it("ignores effort config (gemini does not support effort)", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ effort: "high" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--effort");
    const hasEffort = args.some((a: string) => a.includes("effort"));
    expect(hasEffort).toBe(false);
  });
});

// ---------------------------------------------------------------
// Group 2: Permissions Mapping
// ---------------------------------------------------------------

describe("permissions mapping", () => {
  it("--approval-mode=yolo is always present regardless of permissions", async () => {
    const permissionLevels = ["read-only", "workspace-write", "full-access"];

    for (const perm of permissionLevels) {
      const { process: mockProc, emitStdout, emitClose } = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const config = makeAgentConfig({ permissions: perm });
      const runPromise = backend.run(config, makeStepContext());

      emitStdout("output");
      emitClose(0);
      await runPromise;

      const args: string[] = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1];
      expect(args).toContain("--approval-mode=yolo");
    }
  });
});

// ---------------------------------------------------------------
// Group 3: AgentBackend Interface
// ---------------------------------------------------------------

describe("AgentBackend interface", () => {
  it("name property returns cli-gemini", () => {
    expect(backend.name).toBe("cli-gemini");
  });

  it("implements AgentBackend interface (run method exists)", () => {
    expect(typeof backend.run).toBe("function");
  });
});
