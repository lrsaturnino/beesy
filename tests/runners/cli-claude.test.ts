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

import { ClaudeCLIBackend } from "../../src/runners/cli-claude.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create AgentConfig with Claude-specific defaults and optional overrides. */
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

let backend: InstanceType<typeof ClaudeCLIBackend>;

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

  backend = new ClaudeCLIBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Command Construction
// ---------------------------------------------------------------

describe("command construction", () => {
  it("constructs claude command with --model flag using stripped model ID", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ model: "anthropic/claude-sonnet-4-20250514" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const spawnArgs = mockSpawn.mock.calls[0];
    const args: string[] = spawnArgs[1];
    const modelIdx = args.indexOf("--model");

    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4-20250514");
  });

  it("includes --effort flag when effort is configured", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ effort: "high" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    const effortIdx = args.indexOf("--effort");

    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(args[effortIdx + 1]).toBe("high");
  });

  it("omits --effort flag when effort is undefined", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ effort: undefined });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--effort");
  });

  it("includes --output-format flag when outputFormat is configured", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ outputFormat: "json" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    const fmtIdx = args.indexOf("--output-format");

    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(args[fmtIdx + 1]).toBe("json");
  });

  it("defaults output-format to text when not specified", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ outputFormat: undefined });
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
});

// ---------------------------------------------------------------
// Group 2: Permissions Mapping
// ---------------------------------------------------------------

describe("permissions mapping", () => {
  it("includes --dangerously-skip-permissions for full-access", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "full-access" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("omits --dangerously-skip-permissions for workspace-write", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "workspace-write" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("omits --dangerously-skip-permissions for read-only", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "read-only" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

// ---------------------------------------------------------------
// Group 3: AgentBackend Interface
// ---------------------------------------------------------------

describe("AgentBackend interface", () => {
  it("name property returns cli-claude", () => {
    expect(backend.name).toBe("cli-claude");
  });

  it("implements AgentBackend interface (run method exists)", () => {
    expect(typeof backend.run).toBe("function");
  });
});
