import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initRouter } from "../../src/gates/router.js";
import type { NormalizedMessage, ChannelRef } from "../../src/adapters/types.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-router-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a YAML string to a file in the temp directory. */
async function writeYaml(filename: string, content: string): Promise<void> {
  await writeFile(path.join(tempDir, filename), content, "utf-8");
}

/** Build a NormalizedMessage with sensible defaults. */
function makeMessage(
  command: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    command,
    payload: { description: "test payload" },
    channel: { platform: "slack", channelId: "C123" },
    requestedBy: "U456",
    timestamp: new Date(),
    ...overrides,
  };
}

// -------------------------------------------------------------------
// YAML fixture constants
// -------------------------------------------------------------------

const GATE_ALPHA_YAML = `
gate:
  id: gate-alpha
  name: "Gate Alpha"
  command: /alpha
  description: "First test gate"

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

const GATE_BETA_YAML = `
gate:
  id: gate-beta
  name: "Gate Beta"
  command: /beta
  description: "Second test gate"

input:
  required:
    - description: "What to process"

workflow:
  steps:
    - process

steps:
  process:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
          - write
        timeoutMs: 120000
`;

const GATE_DISABLED_YAML = `
gate:
  id: gate-disabled
  name: "Disabled Gate"
  command: /disabled
  description: "A disabled gate"
  enabled: false

input:
  required:
    - description: "Unused"

workflow:
  steps:
    - noop

steps:
  noop:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 30000
`;

const GATE_INVALID_YAML = `
gate:
  name: "Invalid Gate"
  command: /invalid
  description: "Missing gate.id"

input:
  required:
    - description: "Whatever"

workflow:
  steps:
    - broken

steps:
  broken:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
`;

const GATE_NO_ENABLED_FIELD_YAML = `
gate:
  id: gate-implicit
  name: "Implicit Enabled Gate"
  command: /implicit
  description: "No explicit enabled field"

input:
  required:
    - description: "Something"

workflow:
  steps:
    - run

steps:
  run:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
`;

// -------------------------------------------------------------------
// Group 1: Gate Discovery and Initialization
// -------------------------------------------------------------------
describe("gate discovery and initialization", () => {
  it("discovers all YAML gates from a directory at startup", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    await writeYaml("beta.yaml", GATE_BETA_YAML);

    const router = await initRouter(tempDir);

    const matchAlpha = router.match("/alpha");
    const matchBeta = router.match("/beta");

    expect(matchAlpha).not.toBeNull();
    expect(matchAlpha!.gate.id).toBe("gate-alpha");
    expect(matchBeta).not.toBeNull();
    expect(matchBeta!.gate.id).toBe("gate-beta");
  });

  it("initializes with empty gates directory without error", async () => {
    const router = await initRouter(tempDir);

    expect(router.match("/anything")).toBeNull();
  });

  it("logs validation warnings from loader at startup", async () => {
    await writeYaml("disabled.yaml", GATE_DISABLED_YAML);

    const router = await initRouter(tempDir);

    // The disabled gate triggers a loader warning but is filtered out of the map
    expect(router.match("/disabled")).toBeNull();
  });

  it("fails startup when any gate has validation errors (hard stop)", async () => {
    await writeYaml("invalid.yaml", GATE_INVALID_YAML);

    await expect(initRouter(tempDir)).rejects.toThrow();
  });

  it("fails startup when loader returns mixed valid and invalid gates", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    await writeYaml("invalid.yaml", GATE_INVALID_YAML);

    await expect(initRouter(tempDir)).rejects.toThrow();
  });
});

// -------------------------------------------------------------------
// Group 2: Command Matching
// -------------------------------------------------------------------
describe("command matching", () => {
  it("matches incoming command to the correct gate config", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);

    const router = await initRouter(tempDir);
    const config = router.match("/alpha");

    expect(config).not.toBeNull();
    expect(config!.gate.id).toBe("gate-alpha");
    expect(config!.gate.command).toBe("/alpha");
    expect(config!.workflow.steps).toEqual(["work"]);
    expect(config!.steps.work.execution.type).toBe("agent");
  });

  it("returns null for unknown commands", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);

    const router = await initRouter(tempDir);

    expect(router.match("/nonexistent")).toBeNull();
  });

  it("filters out disabled gates from the command map", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    await writeYaml("disabled.yaml", GATE_DISABLED_YAML);

    const router = await initRouter(tempDir);

    expect(router.match("/alpha")).not.toBeNull();
    expect(router.match("/disabled")).toBeNull();
  });

  it("treats gates with enabled undefined as enabled (default true)", async () => {
    await writeYaml("implicit.yaml", GATE_NO_ENABLED_FIELD_YAML);

    const router = await initRouter(tempDir);
    const config = router.match("/implicit");

    expect(config).not.toBeNull();
    expect(config!.gate.id).toBe("gate-implicit");
  });
});

// -------------------------------------------------------------------
// Group 3: Task Creation
// -------------------------------------------------------------------
describe("task creation", () => {
  it("creates a Task object from matched gate and NormalizedMessage", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    const router = await initRouter(tempDir);

    const channel: ChannelRef = { platform: "slack", channelId: "C999", threadTs: "1234.5678" };
    const message = makeMessage("/alpha", {
      payload: { description: "build a feature" },
      channel,
      requestedBy: "U789",
    });

    const task = router.createTask(message);

    expect(task).not.toBeNull();
    expect(task!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(task!.gate).toBe("gate-alpha");
    expect(task!.status).toBe("queued");
    expect(task!.priority).toBe("normal");
    expect(task!.position).toBe(0);
    expect(task!.payload).toEqual({ description: "build a feature" });
    expect(task!.requestedBy).toBe("U789");
    expect(task!.sourceChannel).toEqual(channel);
    expect(task!.createdAt).toBeInstanceOf(Date);
    expect(task!.cost).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("returns null when creating task for unknown command", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    const router = await initRouter(tempDir);

    const message = makeMessage("/unknown-command");
    const task = router.createTask(message);

    expect(task).toBeNull();
  });

  it("passes NormalizedMessage payload through to Task payload unchanged", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    const router = await initRouter(tempDir);

    const complexPayload = {
      description: "nested test",
      metadata: { nested: { deep: true } },
      tags: ["a", "b", "c"],
      count: 42,
    };
    const message = makeMessage("/alpha", { payload: complexPayload });

    const task = router.createTask(message);

    expect(task).not.toBeNull();
    expect(task!.payload).toEqual(complexPayload);
  });

  it("creates tasks with unique IDs for each invocation", async () => {
    await writeYaml("alpha.yaml", GATE_ALPHA_YAML);
    const router = await initRouter(tempDir);

    const message = makeMessage("/alpha");
    const task1 = router.createTask(message);
    const task2 = router.createTask(message);

    expect(task1).not.toBeNull();
    expect(task2).not.toBeNull();
    expect(task1!.id).not.toBe(task2!.id);
  });
});
