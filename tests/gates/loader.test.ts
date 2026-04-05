import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGates } from "../../src/gates/loader.js";
import type { LoadGatesResult } from "../../src/gates/loader.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-gate-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a YAML string to a file in the temp directory. */
async function writeYaml(filename: string, content: string): Promise<void> {
  await writeFile(path.join(tempDir, filename), content, "utf-8");
}

// -------------------------------------------------------------------
// YAML fixture constants
// -------------------------------------------------------------------

const VALID_MINIMAL_AGENT_YAML = `
gate:
  id: test-gate
  name: "Test Gate"
  command: /test-gate
  description: "A test gate for validation"

input:
  required:
    - description: "What to test"

workflow:
  steps:
    - planning

steps:
  planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
          - write
        timeoutMs: 60000
`;

const VALID_SCRIPT_STEP_YAML = `
gate:
  id: script-gate
  name: "Script Gate"
  command: /script-gate
  description: "Gate with script step"

input:
  required:
    - description: "What to run"

workflow:
  steps:
    - validate

steps:
  validate:
    execution:
      type: script
      command: "node scripts/validate.js"
      timeoutMs: 30000
`;

const VALID_TOOL_STEP_YAML = `
gate:
  id: tool-gate
  name: "Tool Gate"
  command: /tool-gate
  description: "Gate with tool step"

input:
  required:
    - description: "What to process"

workflow:
  steps:
    - create-branch

steps:
  create-branch:
    execution:
      type: tool
      module: src/tools/git-ops
      function: createBranch
`;

const VALID_SNAKE_CASE_YAML = `
gate:
  id: full-gate
  name: "Full Gate"
  command: /full-gate
  description: "Gate with all snake_case fields"

input:
  required:
    - description: "What to implement"

workflow:
  steps:
    - planning
    - implementation
  human_checkpoints:
    - after: planning
      action: discuss_and_confirm
      message: "Review the plan"
      timeout_hours: 2

steps:
  planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
        timeoutMs: 60000
    input_files:
      - ".bees/spec.md"
    output_files:
      - ".bees/planning.md"
  implementation:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools:
          - read
          - write
        timeoutMs: 300000

workspace:
  repo: "test-org/test-repo"
  branch_prefix: "bees/"
  working_dir: ".bees/"
  git_identity:
    name: "Bees Bot"
    email: "bees@test.com"
    token_env: "GITHUB_TOKEN"
`;

const VALID_OPTIONAL_OMITTED_YAML = `
gate:
  id: minimal-gate
  name: "Minimal Gate"
  command: /minimal-gate
  description: "Gate with only required fields"

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

// -------------------------------------------------------------------
// Group 1: Happy Path
// -------------------------------------------------------------------
describe("happy path", () => {
  it("parses valid minimal gate YAML into GateConfig", async () => {
    await writeYaml("test-gate.yaml", VALID_MINIMAL_AGENT_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.configs[0].gate.id).toBe("test-gate");
    expect(result.configs[0].gate.command).toBe("/test-gate");
    expect(result.configs[0].workflow.steps).toEqual(["planning"]);
    expect(result.configs[0].steps.planning.execution.type).toBe("agent");
  });

  it("parses gate YAML with script-type step", async () => {
    await writeYaml("script-gate.yaml", VALID_SCRIPT_STEP_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const step = result.configs[0].steps.validate;
    expect(step.execution.type).toBe("script");
    if (step.execution.type === "script") {
      expect(step.execution.command).toBe("node scripts/validate.js");
      expect(step.execution.timeoutMs).toBe(30000);
    }
  });

  it("parses gate YAML with tool-type step", async () => {
    await writeYaml("tool-gate.yaml", VALID_TOOL_STEP_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const step = result.configs[0].steps["create-branch"];
    expect(step.execution.type).toBe("tool");
    if (step.execution.type === "tool") {
      expect(step.execution.module).toBe("src/tools/git-ops");
      expect(step.execution.function).toBe("createBranch");
    }
  });

  it("transforms snake_case YAML fields to camelCase TypeScript fields", async () => {
    await writeYaml("full-gate.yaml", VALID_SNAKE_CASE_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const config = result.configs[0];

    // human_checkpoints -> humanCheckpoints
    expect(config.workflow.humanCheckpoints).toBeDefined();
    expect(config.workflow.humanCheckpoints![0].after).toBe("planning");
    // timeout_hours -> timeoutHours
    expect(config.workflow.humanCheckpoints![0].timeoutHours).toBe(2);
    // input_files -> inputFiles
    expect(config.steps.planning.inputFiles).toEqual([".bees/spec.md"]);
    // output_files -> outputFiles
    expect(config.steps.planning.outputFiles).toEqual([".bees/planning.md"]);
    // workspace fields
    expect(config.workspace).toBeDefined();
    // branch_prefix -> branchPrefix
    expect(config.workspace!.branchPrefix).toBe("bees/");
    // working_dir -> workingDir
    expect(config.workspace!.workingDir).toBe(".bees/");
    // git_identity -> gitIdentity
    expect(config.workspace!.gitIdentity).toBeDefined();
    expect(config.workspace!.gitIdentity!.name).toBe("Bees Bot");
    // token_env -> tokenEnv
    expect(config.workspace!.gitIdentity!.tokenEnv).toBe("GITHUB_TOKEN");
  });

  it("parses gate YAML with optional fields omitted", async () => {
    await writeYaml("minimal-gate.yaml", VALID_OPTIONAL_OMITTED_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const config = result.configs[0];
    expect(config.workspace).toBeUndefined();
    expect(config.workflow.humanCheckpoints).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 2: Error Conditions (13 cases)
// -------------------------------------------------------------------
describe("error conditions", () => {
  it("rejects gate with missing gate.id", async () => {
    const yaml = `
gate:
  name: "No ID Gate"
  command: /no-id
  description: "Missing id"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("no-id.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.severity === "error" && e.message.toLowerCase().includes("id"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with empty gate.id", async () => {
    const yaml = `
gate:
  id: ""
  name: "Empty ID Gate"
  command: /empty-id
  description: "Empty id"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("empty-id.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("id"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with command not starting with /", async () => {
    const yaml = `
gate:
  id: bad-cmd
  name: "Bad Command"
  command: no-slash
  description: "Command missing slash"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("bad-cmd.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.severity === "error" && e.message.toLowerCase().includes("command"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with missing command", async () => {
    const yaml = `
gate:
  id: no-cmd
  name: "No Command"
  description: "Missing command"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("no-cmd.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("command"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with empty workflow.steps", async () => {
    const yaml = `
gate:
  id: empty-steps
  name: "Empty Steps"
  command: /empty-steps
  description: "Empty workflow steps"

input:
  required:
    - description: "test"

workflow:
  steps: []

steps:
  unused:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("empty-steps.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("steps"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with step reference not in step definitions", async () => {
    const yaml = `
gate:
  id: bad-ref
  name: "Bad Ref"
  command: /bad-ref
  description: "Step ref missing"

input:
  required:
    - description: "test"

workflow:
  steps:
    - nonexistent

steps:
  planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("bad-ref.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.includes("nonexistent"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects gate with invalid execution type", async () => {
    const yaml = `
gate:
  id: bad-type
  name: "Bad Type"
  command: /bad-type
  description: "Invalid exec type"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: invalid
`;
    await writeYaml("bad-type.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("type") || e.message.includes("invalid"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects agent step missing config", async () => {
    const yaml = `
gate:
  id: no-config
  name: "No Config"
  command: /no-config
  description: "Agent missing config"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
`;
    await writeYaml("no-config.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("config"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects script step missing command", async () => {
    const yaml = `
gate:
  id: no-script-cmd
  name: "No Script Command"
  command: /no-script-cmd
  description: "Script missing command"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: script
      timeoutMs: 30000
`;
    await writeYaml("no-script-cmd.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("command"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects tool step missing module or function", async () => {
    const yaml = `
gate:
  id: no-tool-fn
  name: "No Tool Function"
  command: /no-tool-fn
  description: "Tool missing function"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: tool
      module: src/tools/git-ops
`;
    await writeYaml("no-tool-fn.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("function"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects agent step missing model in config", async () => {
    const yaml = `
gate:
  id: no-model
  name: "No Model"
  command: /no-model
  description: "Agent config missing model"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("no-model.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("model"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects agent step missing tools in config", async () => {
    const yaml = `
gate:
  id: no-tools
  name: "No Tools"
  command: /no-tools
  description: "Agent config missing tools"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        timeoutMs: 60000
`;
    await writeYaml("no-tools.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("tools"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects step missing timeoutMs", async () => {
    const yaml = `
gate:
  id: no-timeout
  name: "No Timeout"
  command: /no-timeout
  description: "Agent config missing timeoutMs"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
`;
    await writeYaml("no-timeout.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.toLowerCase().includes("timeout"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });

  it("rejects human_checkpoints referencing undefined step", async () => {
    const yaml = `
gate:
  id: bad-checkpoint
  name: "Bad Checkpoint"
  command: /bad-checkpoint
  description: "Checkpoint refs bad step"

input:
  required:
    - description: "test"

workflow:
  steps:
    - planning
  human_checkpoints:
    - after: nonexistent_step
      action: discuss_and_confirm
      message: "Review something"

steps:
  planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("bad-checkpoint.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.includes("nonexistent_step"))).toBe(true);
    expect(result.configs).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 3: Cross-File Validation (Duplicates)
// -------------------------------------------------------------------
describe("cross-file validation", () => {
  it("rejects duplicate gate.id across files", async () => {
    const yaml1 = `
gate:
  id: same-id
  name: "Gate One"
  command: /gate-one
  description: "First gate"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    const yaml2 = `
gate:
  id: same-id
  name: "Gate Two"
  command: /gate-two
  description: "Second gate with same id"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("gate-one.yaml", yaml1);
    await writeYaml("gate-two.yaml", yaml2);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.severity === "error" && e.message.includes("same-id"))).toBe(true);
  });

  it("rejects duplicate gate.command across files", async () => {
    const yaml1 = `
gate:
  id: gate-alpha
  name: "Alpha"
  command: /same-cmd
  description: "First gate"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    const yaml2 = `
gate:
  id: gate-beta
  name: "Beta"
  command: /same-cmd
  description: "Second gate with same command"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("gate-alpha.yaml", yaml1);
    await writeYaml("gate-beta.yaml", yaml2);
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.severity === "error" && e.message.includes("/same-cmd"))).toBe(true);
  });

  it("loads valid files alongside invalid files with partial results", async () => {
    await writeYaml("valid.yaml", VALID_MINIMAL_AGENT_YAML);
    const invalidYaml = `
gate:
  name: "Invalid Gate"
  command: no-slash
  description: "Missing id and bad command"

input:
  required:
    - description: "test"

workflow:
  steps: []

steps: {}
`;
    await writeYaml("invalid.yaml", invalidYaml);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].gate.id).toBe("test-gate");
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------------------
// Group 4: Warning Conditions
// -------------------------------------------------------------------
describe("warning conditions", () => {
  it("warns on skills directory not found", async () => {
    const yaml = `
gate:
  id: skill-gate
  name: "Skill Gate"
  command: /skill-gate
  description: "Gate with skills"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
        skills:
          - nonexistent-skill
`;
    // Create the skills/ directory but not the specific skill
    await mkdir(path.join(tempDir, "skills"), { recursive: true });
    await writeYaml("skill-gate.yaml", yaml);
    const result = await loadGates(tempDir, { projectRoot: tempDir });

    expect(result.configs).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.severity === "warning" && w.message.includes("nonexistent-skill"))).toBe(true);
  });

  it("warns on input_files that do not exist", async () => {
    const yaml = `
gate:
  id: input-gate
  name: "Input Gate"
  command: /input-gate
  description: "Gate with missing input files"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
    input_files:
      - ".bees/missing-file.md"
`;
    await writeYaml("input-gate.yaml", yaml);
    const result = await loadGates(tempDir, { projectRoot: tempDir });

    expect(result.configs).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.severity === "warning" && w.message.includes("missing-file.md"))).toBe(true);
  });

  it("warns on workspace.repo not accessible", async () => {
    const yaml = `
gate:
  id: repo-gate
  name: "Repo Gate"
  command: /repo-gate
  description: "Gate with workspace repo"

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000

workspace:
  repo: "nonexistent-org/nonexistent-repo"
`;
    await writeYaml("repo-gate.yaml", yaml);
    const result = await loadGates(tempDir, { projectRoot: tempDir });

    expect(result.configs).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.severity === "warning" && w.message.toLowerCase().includes("repo"))).toBe(true);
  });

  it("warns on disabled gate (enabled: false)", async () => {
    const yaml = `
gate:
  id: disabled-gate
  name: "Disabled Gate"
  command: /disabled-gate
  description: "This gate is disabled"
  enabled: false

input:
  required:
    - description: "test"

workflow:
  steps:
    - work

steps:
  work:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read]
        timeoutMs: 60000
`;
    await writeYaml("disabled-gate.yaml", yaml);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].gate.id).toBe("disabled-gate");
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.severity === "warning" && w.message.toLowerCase().includes("disabled"))).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 5: Edge Cases
// -------------------------------------------------------------------
describe("edge cases", () => {
  it("handles empty gates directory", async () => {
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("ignores non-YAML files in gates directory", async () => {
    await writeFile(path.join(tempDir, "readme.txt"), "not a gate", "utf-8");
    await writeYaml("valid.yaml", VALID_MINIMAL_AGENT_YAML);
    const result = await loadGates(tempDir);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].gate.id).toBe("test-gate");
  });

  it("handles malformed YAML gracefully", async () => {
    await writeYaml("broken.yaml", "gate:\n  id: [broken\n  invalid:: yaml::");
    const result = await loadGates(tempDir);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.configs).toHaveLength(0);
  });

  it("collects multiple errors from a single file", async () => {
    const yaml = `
gate:
  name: "Multi Error"
  description: "Many problems"

input:
  required:
    - description: "test"

workflow:
  steps: []

steps:
  work:
    execution:
      type: invalid
`;
    await writeYaml("multi-error.yaml", yaml);
    const result = await loadGates(tempDir);

    // Should have at least: missing gate.id, missing command, empty steps
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.configs).toHaveLength(0);
  });
});
