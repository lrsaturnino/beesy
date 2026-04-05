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

import { CodexCLIBackend } from "../../src/runners/cli-codex.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create AgentConfig with Codex-specific defaults and optional overrides. */
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "openai/o3-mini",
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

let backend: InstanceType<typeof CodexCLIBackend>;

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

  backend = new CodexCLIBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Command Construction
// ---------------------------------------------------------------

describe("command construction", () => {
  it("constructs codex exec command with --model flag using stripped model ID", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ model: "openai/o3-mini" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const command: string = spawnCall[0];
    const args: string[] = spawnCall[1];

    expect(command).toBe("codex");
    expect(args).toContain("exec");

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("o3-mini");
  });

  it("includes -c model_reasoning_effort= flag when effort is configured", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ effort: "medium" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    const cflagIdx = args.indexOf("-c");

    expect(cflagIdx).toBeGreaterThanOrEqual(0);
    expect(args[cflagIdx + 1]).toBe("model_reasoning_effort=medium");
  });

  it("omits effort flag when effort is undefined", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ effort: undefined });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    const hasEffort = args.some((a: string) => a.includes("model_reasoning_effort"));
    expect(hasEffort).toBe(false);
  });

  it("includes --skip-git-repo-check flag always", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--skip-git-repo-check");
  });

  it("includes -o flag with output file path", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const runPromise = backend.run(makeAgentConfig(), makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("-o");
  });
});

// ---------------------------------------------------------------
// Group 2: Permissions Mapping
// ---------------------------------------------------------------

describe("permissions mapping", () => {
  it("includes --dangerously-bypass-approvals-and-sandbox for full-access", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "full-access" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("omits --dangerously-bypass-approvals-and-sandbox for workspace-write", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "workspace-write" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("omits --dangerously-bypass-approvals-and-sandbox for read-only", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const config = makeAgentConfig({ permissions: "read-only" });
    const runPromise = backend.run(config, makeStepContext());

    emitStdout("output");
    emitClose(0);
    await runPromise;

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

// ---------------------------------------------------------------
// Group 3: Output Capture
// ---------------------------------------------------------------

describe("output capture", () => {
  it("reads output from file instead of stdout", async () => {
    const { process: mockProc, emitStdout, emitClose } = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    // Configure readFile to return the file content when output file is read
    mockReadFile.mockResolvedValue("output from file content");

    const config = makeAgentConfig();
    const runPromise = backend.run(config, makeStepContext());

    // Stdout data should be ignored for codex; output comes from file
    emitStdout("this should be ignored for output");
    emitClose(0);

    const result = await runPromise;

    // Output should come from the file read, not from stdout
    expect(result.output).toContain("output from file content");
  });
});

// ---------------------------------------------------------------
// Group 4: AgentBackend Interface
// ---------------------------------------------------------------

describe("AgentBackend interface", () => {
  it("name property returns cli-codex", () => {
    expect(backend.name).toBe("cli-codex");
  });

  it("implements AgentBackend interface (run method exists)", () => {
    expect(typeof backend.run).toBe("function");
  });
});
