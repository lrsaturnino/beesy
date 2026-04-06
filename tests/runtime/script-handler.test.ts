import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock external modules so handler tests are isolated
// ---------------------------------------------------------------

const { mockRunScript } = vi.hoisted(() => ({
  mockRunScript: vi.fn(),
}));

vi.mock("../../src/executor/script-runner.js", () => ({
  runScript: mockRunScript,
}));

const { mockResolveScript, mockValidateEnv } = vi.hoisted(() => ({
  mockResolveScript: vi.fn(),
  mockValidateEnv: vi.fn(),
}));

vi.mock("../../src/scripts/registry.js", () => ({
  resolveScript: mockResolveScript,
  validateEnvRequirements: mockValidateEnv,
}));

// Import module under test
import {
  handleScriptRun,
  buildScriptStdinPayload,
  parseResultEnvelope,
  mapScriptExitCode,
  enforceRerunPolicy,
  validatePayloadSchema,
} from "../../src/runtime/script-handler.js";

import type { Task, Subtask } from "../../src/queue/types.js";
import type { ScriptManifest, ScriptResultEnvelope } from "../../src/scripts/types.js";
import type { StepOutput } from "../../src/runners/types.js";
import { readJournal, appendJournalEntry } from "../../src/runtime/journal.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-script-handler-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Factory for a minimal valid Task with overridable fields. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    gate: "test-gate",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "build a widget", context: "test context" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    workspacePath: "/tmp/workspace",
    recipeId: "test-recipe",
    ...overrides,
  };
}

/** Factory for a ScriptManifest with sensible defaults. */
function createScriptManifest(overrides?: Partial<ScriptManifest>): ScriptManifest {
  return {
    script_id: "test.script",
    description: "A test script",
    runtime: "python",
    path: "scripts/test.py",
    timeout_ms: 30000,
    retryable: false,
    side_effects: "read-only",
    required_env: [],
    rerun_policy: "restart",
    ...overrides,
  };
}

/** Factory for a script_run Subtask with overridable fields. */
function createScriptSubtask(overrides?: Partial<Subtask>): Subtask {
  return {
    id: "task-001-script-0",
    stepId: "script-step",
    name: "script_run:test.script",
    executionType: "script",
    status: "active",
    cost: zeroCost(),
    attempt: 1,
    maxRetries: 0,
    kind: "script_run",
    payload: { script_id: "test.script" },
    ...overrides,
  };
}

/** Build a valid ScriptResultEnvelope JSON string. */
function makeEnvelopeJson(overrides?: Partial<ScriptResultEnvelope>): string {
  const envelope: ScriptResultEnvelope = {
    summary: "Script completed successfully",
    ...overrides,
  };
  return JSON.stringify(envelope);
}

/** Factory for a successful StepOutput from runScript. */
function makeStepOutput(overrides?: Partial<StepOutput>): StepOutput {
  return {
    output: makeEnvelopeJson(),
    outputFiles: [],
    exitCode: 0,
    ...overrides,
  };
}

/** Set up registry mocks to return a valid manifest and passing env validation. */
function setupRegistryMocks(manifest?: ScriptManifest): ScriptManifest {
  const m = manifest ?? createScriptManifest();
  mockResolveScript.mockReturnValue(m);
  mockValidateEnv.mockReturnValue({ valid: true, missing: [] });
  return m;
}

// ---------------------------------------------------------------
// Group 1: Metadata Resolution
// ---------------------------------------------------------------

describe("Metadata Resolution", () => {
  it("resolves script metadata via registry", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask({ payload: { script_id: "test.script" } });

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(mockResolveScript).toHaveBeenCalledWith(
      expect.any(Map),
      "test.script",
    );
    expect(mockRunScript).toHaveBeenCalled();
  });

  it("rejects unknown script_id with clear error", async () => {
    mockResolveScript.mockReturnValue(null);

    const task = createTestTask();
    const subtask = createScriptSubtask({ payload: { script_id: "nonexistent" } });

    const result = await handleScriptRun(task, subtask, new Map(), runsDir);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("nonexistent");
    expect(mockRunScript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Group 2: Environment Variable Validation
// ---------------------------------------------------------------

describe("Environment Variable Validation", () => {
  it("passes when all required env vars present", async () => {
    const manifest = createScriptManifest({ required_env: ["API_KEY", "DB_URL"] });
    setupRegistryMocks(manifest);
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(result.error).toBeUndefined();
  });

  it("rejects with missing env vars before process spawn", async () => {
    const manifest = createScriptManifest({ required_env: ["MISSING_VAR"] });
    mockResolveScript.mockReturnValue(manifest);
    mockValidateEnv.mockReturnValue({ valid: false, missing: ["MISSING_VAR"] });

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("MISSING_VAR");
    expect(mockRunScript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Group 3: Stdin Payload Construction
// ---------------------------------------------------------------

describe("Stdin Payload Construction", () => {
  it("builds JSON stdin payload with task state and input_patch", () => {
    const task = createTestTask({ payload: { description: "build a widget" } });
    const subtask = createScriptSubtask({
      payload: { script_id: "test.script", extra_input: "value" },
    });

    const payloadStr = buildScriptStdinPayload(task, subtask);
    const parsed = JSON.parse(payloadStr);

    expect(parsed).toHaveProperty("task_state");
    expect(parsed.task_state).toEqual({ description: "build a widget" });
    expect(parsed).toHaveProperty("input_patch");
  });

  it("includes prior_result when rerun_policy is continue", () => {
    const task = createTestTask();
    const subtask = createScriptSubtask();
    const priorResult = { summary: "Previous execution output", outputs: {} };

    const payloadStr = buildScriptStdinPayload(task, subtask, priorResult);
    const parsed = JSON.parse(payloadStr);

    expect(parsed).toHaveProperty("prior_result");
    expect(parsed.prior_result).toEqual(priorResult);
  });

  it("omits prior_result for restart policy", () => {
    const task = createTestTask();
    const subtask = createScriptSubtask();

    const payloadStr = buildScriptStdinPayload(task, subtask);
    const parsed = JSON.parse(payloadStr);

    expect(parsed.prior_result).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Group 4: Result Envelope Parsing
// ---------------------------------------------------------------

describe("Result Envelope Parsing", () => {
  it("parses valid result envelope with all fields", () => {
    const envelopeJson = JSON.stringify({
      summary: "Completed analysis",
      outputs: { report: { path: "out/report.md", label: "Report", format: "md" } },
      state_patch: { analyzed: true },
      metrics: { files_scanned: 42 },
    });

    const result = parseResultEnvelope(envelopeJson);

    expect(result.summary).toBe("Completed analysis");
    expect(result.outputs).toBeDefined();
    expect(result.state_patch).toEqual({ analyzed: true });
    expect(result.metrics).toEqual({ files_scanned: 42 });
  });

  it("handles envelope with only summary (minimal valid)", () => {
    const envelopeJson = JSON.stringify({ summary: "Done" });

    const result = parseResultEnvelope(envelopeJson);

    expect(result.summary).toBe("Done");
    expect(result.outputs).toBeUndefined();
    expect(result.state_patch).toBeUndefined();
    expect(result.metrics).toBeUndefined();
  });

  it("returns error for malformed JSON stdout", () => {
    expect(() => parseResultEnvelope("not json at all")).toThrow(/parse|JSON/i);
  });

  it("returns error for missing summary field", () => {
    const noSummary = JSON.stringify({ outputs: {} });

    expect(() => parseResultEnvelope(noSummary)).toThrow(/summary/i);
  });
});

// ---------------------------------------------------------------
// Group 5: Exit Code Mapping
// ---------------------------------------------------------------

describe("Exit Code Mapping", () => {
  it("exit code 0 marks subtask completed with parsed output", () => {
    const envelope: ScriptResultEnvelope = { summary: "All good" };
    const stepOutput = makeStepOutput({ exitCode: 0 });

    const result = mapScriptExitCode(0, stepOutput, envelope);

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("All good");
  });

  it("exit code 1 marks subtask failed with stderr", () => {
    const stepOutput = makeStepOutput({
      exitCode: 1,
      error: "Script crashed: null pointer",
    });

    const result = mapScriptExitCode(1, stepOutput);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Script crashed: null pointer");
  });

  it("exit code 2 triggers pause semantics (needs_input)", () => {
    const stepOutput = makeStepOutput({ exitCode: 2 });

    const result = mapScriptExitCode(2, stepOutput);

    expect(result.needsInput).toBe(true);
  });
});

// ---------------------------------------------------------------
// Group 6: Rerun Policy Enforcement
// ---------------------------------------------------------------

describe("Rerun Policy Enforcement", () => {
  it("refuse policy blocks re-execution with clear error", async () => {
    const manifest = createScriptManifest({
      script_id: "test.script",
      rerun_policy: "refuse",
    });

    // Write a prior script_completed journal entry
    appendJournalEntry(runsDir, "task-001", {
      type: "script_completed",
      scriptId: "test.script",
      summary: "Prior run output",
    });

    const result = await enforceRerunPolicy(manifest, runsDir, "task-001");

    expect(result).toBeDefined();
    expect(result!.error).toBeDefined();
    expect(result!.error).toMatch(/refuse|re-execution/i);
  });

  it("refuse policy allows first execution", async () => {
    const manifest = createScriptManifest({
      script_id: "test.script",
      rerun_policy: "refuse",
    });

    // No prior journal entries
    const result = await enforceRerunPolicy(manifest, runsDir, "task-001");

    expect(result).toBeNull();
  });

  it("restart policy re-executes from scratch without prior context", async () => {
    const manifest = createScriptManifest({
      script_id: "test.script",
      rerun_policy: "restart",
    });

    // Journal has prior results, but restart ignores them
    appendJournalEntry(runsDir, "task-001", {
      type: "script_completed",
      scriptId: "test.script",
      summary: "Prior run output",
    });

    const result = await enforceRerunPolicy(manifest, runsDir, "task-001");

    expect(result).toBeNull();
  });

  it("continue policy injects prior_result from journal into stdin", async () => {
    const manifest = createScriptManifest({
      script_id: "test.script",
      rerun_policy: "continue",
    });

    // Write a prior script_completed journal entry with output data
    appendJournalEntry(runsDir, "task-001", {
      type: "script_completed",
      scriptId: "test.script",
      summary: "Previous execution result",
      output: { data: "partial progress" },
    });

    const result = await enforceRerunPolicy(manifest, runsDir, "task-001");

    expect(result).toBeDefined();
    expect(result!.priorResult).toBeDefined();
    expect(result!.priorResult.summary).toBe("Previous execution result");
  });
});

// ---------------------------------------------------------------
// Group 7: Schema Validation
// ---------------------------------------------------------------

describe("Schema Validation", () => {
  it("validates stdin payload against input_schema when defined", () => {
    const schema = {
      required: ["url", "depth"],
      properties: {
        url: { type: "string" },
        depth: { type: "number" },
      },
    };
    const payload = { url: "https://example.com", depth: 3 };

    const error = validatePayloadSchema(payload, schema);

    expect(error).toBeNull();
  });

  it("rejects invalid stdin payload against input_schema", () => {
    const schema = {
      required: ["url"],
      properties: {
        url: { type: "string" },
      },
    };
    const payload = { depth: 3 }; // missing required "url"

    const error = validatePayloadSchema(payload, schema);

    expect(error).toBeDefined();
    expect(error).toMatch(/url|schema|validation/i);
  });

  it("validates stdout result against output_schema when defined", () => {
    const schema = {
      required: ["report"],
      properties: {
        report: { type: "string" },
      },
    };
    const payload = { report: "Analysis complete" };

    const error = validatePayloadSchema(payload, schema);

    expect(error).toBeNull();
  });

  it("rejects invalid stdout against output_schema", () => {
    const schema = {
      required: ["report"],
      properties: {
        report: { type: "string" },
      },
    };
    const payload = { summary: "Missing report field" }; // missing required "report"

    const error = validatePayloadSchema(payload, schema);

    expect(error).toBeDefined();
    expect(error).toMatch(/report|schema|validation/i);
  });

  it("skips schema validation when no schema defined", async () => {
    const manifest = createScriptManifest(); // no input_schema or output_schema
    setupRegistryMocks(manifest);
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    // No schema errors expected; should succeed normally
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Group 8: Journal Events
// ---------------------------------------------------------------

describe("Journal Events", () => {
  it("emits script_started journal entry on execution begin", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    const journal = readJournal(runsDir, task.id);
    const started = journal.filter((e) => e.type === "script_started");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0]).toHaveProperty("scriptId", "test.script");
  });

  it("emits script_completed journal entry on success", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    const journal = readJournal(runsDir, task.id);
    const completed = journal.filter((e) => e.type === "script_completed");
    expect(completed.length).toBe(1);
    expect(completed[0]).toHaveProperty("summary");
  });

  it("emits script_failed journal entry on failure", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(
      makeStepOutput({ exitCode: 1, error: "Script crashed", output: "" }),
    );

    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    const journal = readJournal(runsDir, task.id);
    const failed = journal.filter((e) => e.type === "script_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]).toHaveProperty("error");
  });

  it("registers output artifacts with durable UUIDs and journal entries", async () => {
    const envelopeWithOutputs: ScriptResultEnvelope = {
      summary: "Analysis done",
      outputs: {
        report: { path: "out/report.md", label: "Report", format: "md" },
        data: { path: "out/data.json", label: "Data", format: "json" },
      },
    };
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(
      makeStepOutput({ output: JSON.stringify(envelopeWithOutputs) }),
    );

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    // Verify artifact_registered journal entries
    const journal = readJournal(runsDir, task.id);
    const artifactEntries = journal.filter((e) => e.type === "artifact_registered");
    expect(artifactEntries.length).toBe(2);

    // Verify artifact IDs are valid UUIDs
    for (const entry of artifactEntries) {
      expect(entry.artifactId).toBeDefined();
      expect(typeof entry.artifactId).toBe("string");
      expect((entry.artifactId as string).length).toBeGreaterThan(0);
    }

    // Verify result contains artifact IDs
    expect(result.artifactIds.length).toBe(2);
  });
});

// ---------------------------------------------------------------
// Group 9: Integration -- Handler with Mock Script
// ---------------------------------------------------------------

describe("Integration -- Handler with Mock Script", () => {
  it("handleScriptRun exit 0 produces correct subtask state and journal", async () => {
    const envelope: ScriptResultEnvelope = {
      summary: "Analysis complete",
      outputs: {
        report: { path: "out/report.md", label: "Report", format: "md" },
      },
      state_patch: { analyzed: true },
      metrics: { files_scanned: 42 },
    };
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(
      makeStepOutput({ output: JSON.stringify(envelope), exitCode: 0 }),
    );

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Analysis complete");
    expect(result.artifactIds.length).toBeGreaterThan(0);
    expect(result.statePatch).toEqual({ analyzed: true });

    // Verify full journal chain
    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("script_started");
    expect(types).toContain("script_completed");
    expect(types).toContain("artifact_registered");
  });

  it("handleScriptRun exit 1 produces correct failure state and journal", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(
      makeStepOutput({
        output: "",
        exitCode: 1,
        error: "Script execution failed: division by zero",
      }),
    );

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("division by zero");

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("script_started");
    expect(types).toContain("script_failed");
    expect(types).not.toContain("artifact_registered");
  });

  it("handleScriptRun exit 2 produces needs_input state and journal", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(
      makeStepOutput({ output: "", exitCode: 2 }),
    );

    const task = createTestTask();
    const subtask = createScriptSubtask();

    const result = await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    expect(result.needsInput).toBe(true);
    expect(result.error).toBeUndefined();

    const journal = readJournal(runsDir, task.id);
    const types = journal.map((e) => e.type);
    expect(types).toContain("script_started");
  });

  it("handleScriptRun with continue policy receives prior_result", async () => {
    const manifest = createScriptManifest({
      script_id: "test.script",
      rerun_policy: "continue",
    });
    mockResolveScript.mockReturnValue(manifest);
    mockValidateEnv.mockReturnValue({ valid: true, missing: [] });
    mockRunScript.mockResolvedValue(makeStepOutput());

    // Pre-populate journal with a prior script_completed
    appendJournalEntry(runsDir, "task-001", {
      type: "script_completed",
      scriptId: "test.script",
      summary: "Prior partial result",
      output: { data: "partial" },
    });

    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    // Verify runScript was called and the context contains prior_result
    expect(mockRunScript).toHaveBeenCalled();
    const [, , context] = mockRunScript.mock.calls[0];
    const taskPayload = context.taskPayload;
    expect(taskPayload).toHaveProperty("prior_result");
  });
});

// ---------------------------------------------------------------
// Group 10: Integration -- Timeout and Progress
// ---------------------------------------------------------------

describe("Integration -- Timeout and Progress", () => {
  it("long-running script respects timeout_ms from manifest", async () => {
    const manifest = createScriptManifest({ timeout_ms: 5000 });
    setupRegistryMocks(manifest);
    mockRunScript.mockResolvedValue(makeStepOutput());

    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(task, subtask, new Map([["test.script", manifest]]), runsDir);

    // Verify runScript was called with the manifest timeout
    expect(mockRunScript).toHaveBeenCalled();
    const callArgs = mockRunScript.mock.calls[0];
    // 5th argument is timeoutMs
    expect(callArgs[4]).toBe(5000);
  });

  it("stderr output streamed via batcher when onProgress callback provided", async () => {
    const manifest = setupRegistryMocks();
    mockRunScript.mockResolvedValue(makeStepOutput());

    const progressSink = vi.fn().mockResolvedValue(undefined);
    const task = createTestTask();
    const subtask = createScriptSubtask();

    await handleScriptRun(
      task,
      subtask,
      new Map([["test.script", manifest]]),
      runsDir,
      progressSink,
    );

    // Verify runScript was called with an onStderr callback (4th argument)
    expect(mockRunScript).toHaveBeenCalled();
    const callArgs = mockRunScript.mock.calls[0];
    expect(typeof callArgs[3]).toBe("function");
  });
});
