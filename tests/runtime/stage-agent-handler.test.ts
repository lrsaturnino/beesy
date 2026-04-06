import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock the registry module so handler tests are isolated
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

// Import module under test
import {
  resolveInputs,
  renderPrompt,
  executeStageAgent,
  normalizeOutput,
  handleStageAgentRun,
  findLatestScriptOutput,
} from "../../src/runtime/stage-agent-handler.js";

import type { Task, Subtask } from "../../src/queue/types.js";
import type {
  StageDefinition,
  StageInput,
  StageOutput,
  RecipeConfig,
  OrchestratorConfig,
} from "../../src/recipes/types.js";
import type {
  StepOutput,
  AgentBackend,
  AgentConfig,
} from "../../src/runners/types.js";
import { readJournal, appendJournalEntry } from "../../src/runtime/journal.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;
let workspaceDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-stage-handler-test-"));
  workspaceDir = await mkdtemp(path.join(tmpdir(), "bees-workspace-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
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
    payload: { description: "build a widget" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    workspacePath: workspaceDir,
    recipeId: "new-implementation",
    currentStageId: "planning",
    ...overrides,
  };
}

/** Factory for a StageInput with overridable fields. */
function createStageInput(overrides?: Partial<StageInput>): StageInput {
  return {
    description: "Project description",
    source: "task.payload.description",
    ...overrides,
  };
}

/** Factory for a StageOutput with overridable fields. */
function createStageOutput(overrides?: Partial<StageOutput>): StageOutput {
  return {
    label: "planning_doc",
    format: "md",
    ...overrides,
  };
}

/** Factory for a minimal StageDefinition with overridable fields. */
function createStageDefinition(overrides?: Partial<StageDefinition>): StageDefinition {
  return {
    role: path.join(runsDir, "roles", "planner.md"),
    objective: "Create a detailed implementation plan",
    inputs: [createStageInput()],
    outputs: [createStageOutput()],
    allowed_transitions: ["coding"],
    allowed_scripts: [],
    ...overrides,
  };
}

/** Factory for OrchestratorConfig with overridable fields. */
function createOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    role: "roles/orchestrator.md",
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 120000,
    max_stage_retries: 3,
    max_total_actions: 50,
    ...overrides,
  };
}

/** Factory for RecipeConfig with overridable fields. */
function createRecipeConfig(overrides?: Partial<RecipeConfig>): RecipeConfig {
  return {
    id: "new-implementation",
    name: "New Implementation",
    command: "/new-implementation",
    description: "Full implementation workflow",
    orchestrator: createOrchestratorConfig(),
    stage_order: ["planning", "coding", "review"],
    start_stage: "planning",
    stages: {
      planning: createStageDefinition(),
    },
    ...overrides,
  };
}

/** Factory for a Subtask with stage_agent_run kind. */
function createSubtask(overrides?: Partial<Subtask>): Subtask {
  return {
    id: "task-001-0",
    stepId: "planning",
    name: "stage_agent_run:planning",
    executionType: "agent",
    status: "active",
    cost: zeroCost(),
    attempt: 1,
    maxRetries: 0,
    kind: "stage_agent_run",
    stageId: "planning",
    payload: {},
    ...overrides,
  };
}

/** Factory for a StepOutput with sensible defaults. */
function makeStepOutput(overrides?: Partial<StepOutput>): StepOutput {
  return {
    output: "Generated planning document content",
    outputFiles: [],
    ...overrides,
  };
}

/** Create a stub AgentBackend with controllable run() return. */
function makeStubBackend(name: string, output?: StepOutput): AgentBackend {
  return {
    name,
    run: vi.fn().mockResolvedValue(output ?? makeStepOutput()),
  };
}

/** Write a role file to the temporary directory for tests. */
async function writeRoleFile(rolePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(rolePath), { recursive: true });
  await writeFile(rolePath, content, "utf-8");
}

/** Create the task run directory for artifact storage. */
async function createTaskRunDir(taskId: string): Promise<void> {
  await mkdir(path.join(runsDir, taskId), { recursive: true });
}

// ---------------------------------------------------------------
// Group 1: resolveInputs -- Source Path Extraction
// ---------------------------------------------------------------

describe("resolveInputs -- Source Path Extraction", () => {
  it("resolves simple source path from task payload", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "build a widget" } });

    const result = resolveInputs(stage, task);

    expect(result).toHaveProperty("description");
    expect(result.description).toBe("build a widget");
  });

  it("resolves nested source path from task payload", () => {
    const stage = createStageDefinition({
      inputs: [
        createStageInput({
          description: "Frontend requirements",
          source: "task.payload.requirements.frontend",
        }),
      ],
    });
    const task = createTestTask({
      payload: { requirements: { frontend: "React app" } },
    });

    const result = resolveInputs(stage, task);

    expect(Object.values(result)).toContain("React app");
  });

  it("returns undefined for missing source path", () => {
    const stage = createStageDefinition({
      inputs: [
        createStageInput({
          description: "Missing field",
          source: "task.payload.nonexistent",
        }),
      ],
    });
    const task = createTestTask({ payload: { description: "test" } });

    const result = resolveInputs(stage, task);

    const values = Object.values(result);
    expect(values.some((v) => v === undefined)).toBe(true);
  });

  it("resolves multiple inputs from different sources", () => {
    const stage = createStageDefinition({
      inputs: [
        createStageInput({
          description: "Description",
          source: "task.payload.description",
        }),
        createStageInput({
          description: "Tech stack",
          source: "task.payload.tech_stack",
        }),
      ],
    });
    const task = createTestTask({
      payload: { description: "build a widget", tech_stack: "React + Node" },
    });

    const result = resolveInputs(stage, task);

    const values = Object.values(result);
    expect(values).toContain("build a widget");
    expect(values).toContain("React + Node");
  });
});

// ---------------------------------------------------------------
// Group 2: resolveInputs -- Input Patch Merging
// ---------------------------------------------------------------

describe("resolveInputs -- Input Patch Merging", () => {
  it("applies orchestrator input_patch to resolved inputs", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "build a widget" } });
    const inputPatch = { extra_context: "additional architectural notes" };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.extra_context).toBe("additional architectural notes");
    expect(result.description).toBe("build a widget");
  });

  it("input_patch overrides conflicting resolved input values", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "original value" } });
    const inputPatch = { description: "patched value" };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.description).toBe("patched value");
  });

  it("handles empty or undefined input_patch gracefully", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "build a widget" } });

    const resultUndefined = resolveInputs(stage, task, undefined);
    const resultEmpty = resolveInputs(stage, task, {});

    expect(resultUndefined.description).toBe("build a widget");
    expect(resultEmpty.description).toBe("build a widget");
  });
});

// ---------------------------------------------------------------
// Group 3: renderPrompt -- Format Verification
// ---------------------------------------------------------------

describe("renderPrompt -- Format Verification", () => {
  it("produces three-section prompt with Role, Task, Output headers", () => {
    const roleContent = "You are a planning agent.";
    const objective = "Create a detailed implementation plan";
    const resolvedInputs = { description: "build a widget" };
    const outputs: readonly StageOutput[] = [createStageOutput()];

    const prompt = renderPrompt(roleContent, objective, resolvedInputs, outputs);

    expect(prompt).toContain("# Role");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("# Output");
    expect(prompt).toContain("You are a planning agent.");

    const roleIdx = prompt.indexOf("# Role");
    const taskIdx = prompt.indexOf("# Task");
    const outputIdx = prompt.indexOf("# Output");
    expect(roleIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(outputIdx);
  });

  it("includes resolved inputs in Task section", () => {
    const roleContent = "You are a planner.";
    const objective = "Plan the project";
    const resolvedInputs = {
      description: "build a widget",
      tech_stack: "React + Node",
    };
    const outputs: readonly StageOutput[] = [createStageOutput()];

    const prompt = renderPrompt(roleContent, objective, resolvedInputs, outputs);

    const taskSection = prompt.slice(
      prompt.indexOf("# Task"),
      prompt.indexOf("# Output"),
    );
    expect(taskSection).toContain("build a widget");
    expect(taskSection).toContain("React + Node");
  });

  it("includes output contract in Output section", () => {
    const roleContent = "You are a planner.";
    const objective = "Plan the project";
    const resolvedInputs = {};
    const outputs: readonly StageOutput[] = [
      createStageOutput({ label: "planning_doc", format: "md" }),
      createStageOutput({ label: "architecture_diagram", format: "json" }),
    ];

    const prompt = renderPrompt(roleContent, objective, resolvedInputs, outputs);

    const outputSection = prompt.slice(prompt.indexOf("# Output"));
    expect(outputSection).toContain("planning_doc");
    expect(outputSection).toContain("md");
    expect(outputSection).toContain("architecture_diagram");
    expect(outputSection).toContain("json");
  });

  it("handles empty inputs gracefully", () => {
    const roleContent = "You are a planner.";
    const objective = "Plan the project";
    const resolvedInputs = {};
    const outputs: readonly StageOutput[] = [createStageOutput()];

    const prompt = renderPrompt(roleContent, objective, resolvedInputs, outputs);

    expect(prompt).toContain("# Role");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("# Output");
    expect(prompt).toContain("Plan the project");
  });
});

// ---------------------------------------------------------------
// Group 4: executeStageAgent -- CLI Worker Invocation
// ---------------------------------------------------------------

describe("executeStageAgent -- CLI Worker Invocation", () => {
  it("invokes CLI worker via resolveAgentBackend", async () => {
    const backend = makeStubBackend("cli-claude");
    mockResolveAgentBackend.mockReturnValue(backend);

    const prompt = "# Role\nPlanner\n\n# Task\nPlan\n\n# Output\nplan.md";
    const recipe = createRecipeConfig();
    const task = createTestTask();
    const subtask = createSubtask();

    await executeStageAgent(prompt, recipe, task, subtask);

    expect(mockResolveAgentBackend).toHaveBeenCalledOnce();
    expect(backend.run).toHaveBeenCalledOnce();
  });

  it("passes rendered prompt as system prompt in agent config", async () => {
    const backend = makeStubBackend("cli-claude");
    mockResolveAgentBackend.mockReturnValue(backend);

    const prompt = "# Role\nSpecific role content\n\n# Task\nSpecific task\n\n# Output\nplan";
    const recipe = createRecipeConfig();
    const task = createTestTask();
    const subtask = createSubtask();

    await executeStageAgent(prompt, recipe, task, subtask);

    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(passedConfig.systemPrompt).toContain("Specific role content");
  });

  it("returns StepOutput from backend execution", async () => {
    const expectedOutput = makeStepOutput({
      output: "Planning document generated",
      outputFiles: ["plan.md"],
    });
    const backend = makeStubBackend("cli-claude", expectedOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    const prompt = "# Role\nPlanner\n\n# Task\nPlan\n\n# Output\nplan";
    const recipe = createRecipeConfig();
    const task = createTestTask();
    const subtask = createSubtask();

    const result = await executeStageAgent(prompt, recipe, task, subtask);

    expect(result).toBe(expectedOutput);
  });

  it("propagates backend execution errors", async () => {
    const backend = makeStubBackend("cli-claude");
    (backend.run as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("backend execution failed"),
    );
    mockResolveAgentBackend.mockReturnValue(backend);

    const prompt = "# Role\nPlanner\n\n# Task\nPlan\n\n# Output\nplan";
    const recipe = createRecipeConfig();
    const task = createTestTask();
    const subtask = createSubtask();

    await expect(
      executeStageAgent(prompt, recipe, task, subtask),
    ).rejects.toThrow("backend execution failed");
  });
});

// ---------------------------------------------------------------
// Group 5: normalizeOutput -- Artifact Storage
// ---------------------------------------------------------------

describe("normalizeOutput -- Artifact Storage", () => {
  it("generates durable artifact ID for each stage output", async () => {
    const stepOutput = makeStepOutput({ output: "Planning doc content" });
    const stage = createStageDefinition({
      outputs: [createStageOutput({ label: "planning_doc", format: "md" })],
    });
    const task = createTestTask();
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    const result = await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    expect(result.artifactIds).toBeDefined();
    expect(result.artifactIds.length).toBe(1);
    expect(typeof result.artifactIds[0]).toBe("string");
    expect(result.artifactIds[0].length).toBeGreaterThan(0);
  });

  it("stores artifact content to filesystem", async () => {
    const artifactContent = "Detailed planning document with architecture decisions";
    const stepOutput = makeStepOutput({ output: artifactContent });
    const stage = createStageDefinition({
      outputs: [createStageOutput({ label: "planning_doc", format: "md" })],
    });
    const task = createTestTask();
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    const result = await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const artifactsDir = path.join(runsDir, task.id, "artifacts");
    const entries = await readdir(artifactsDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const artifactFile = entries.find((e) => e.endsWith(".md"));
    expect(artifactFile).toBeDefined();
    const content = await readFile(path.join(artifactsDir, artifactFile!), "utf-8");
    expect(content).toBe(artifactContent);
  });

  it("appends artifact_registered journal entry", async () => {
    const stepOutput = makeStepOutput({ output: "Doc content" });
    const stage = createStageDefinition({
      outputs: [createStageOutput({ label: "planning_doc", format: "md" })],
    });
    const task = createTestTask();
    const subtask = createSubtask({ stageId: "planning" });
    await createTaskRunDir(task.id);

    await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const journal = readJournal(runsDir, task.id);
    const artifactEntries = journal.filter((e) => e.type === "artifact_registered");
    expect(artifactEntries.length).toBe(1);
    expect(artifactEntries[0]).toHaveProperty("artifactId");
    expect(artifactEntries[0]).toHaveProperty("label", "planning_doc");
  });

  it("returns structured result with artifact IDs", async () => {
    const stepOutput = makeStepOutput({ output: "Output content" });
    const stage = createStageDefinition({
      outputs: [
        createStageOutput({ label: "planning_doc", format: "md" }),
        createStageOutput({ label: "architecture", format: "json" }),
      ],
    });
    const task = createTestTask();
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    const result = await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    expect(result.artifactIds).toHaveLength(2);
    expect(result.output).toBe("Output content");
    expect(result.artifactIds[0]).not.toBe(result.artifactIds[1]);
  });
});

// ---------------------------------------------------------------
// Group 6: Compatibility Mirror Creation
// ---------------------------------------------------------------

describe("Compatibility Mirror Creation", () => {
  it("creates compatibility mirror when mirror_to is set", async () => {
    const stepOutput = makeStepOutput({ output: "Mirror test content" });
    const stage = createStageDefinition({
      outputs: [
        createStageOutput({
          label: "planning_doc",
          format: "md",
          mirror_to: [".bees/planning.md"],
        }),
      ],
    });
    const task = createTestTask({ workspacePath: workspaceDir });
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const mirrorPath = path.join(workspaceDir, ".bees", "planning.md");
    const content = await readFile(mirrorPath, "utf-8");
    expect(content).toBe("Mirror test content");
  });

  it("creates multiple mirrors when multiple paths specified", async () => {
    const stepOutput = makeStepOutput({ output: "Multi-mirror content" });
    const stage = createStageDefinition({
      outputs: [
        createStageOutput({
          label: "planning_doc",
          format: "md",
          mirror_to: [".bees/planning.md", ".bees/plan.md"],
        }),
      ],
    });
    const task = createTestTask({ workspacePath: workspaceDir });
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const mirror1 = await readFile(path.join(workspaceDir, ".bees", "planning.md"), "utf-8");
    const mirror2 = await readFile(path.join(workspaceDir, ".bees", "plan.md"), "utf-8");
    expect(mirror1).toBe("Multi-mirror content");
    expect(mirror2).toBe("Multi-mirror content");
  });

  it("skips mirror when mirror_to is undefined", async () => {
    const stepOutput = makeStepOutput({ output: "No mirror content" });
    const stage = createStageDefinition({
      outputs: [
        createStageOutput({ label: "planning_doc", format: "md" }),
      ],
    });
    const task = createTestTask({ workspacePath: workspaceDir });
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const beesDir = path.join(workspaceDir, ".bees");
    let exists = true;
    try {
      await readdir(beesDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("creates intermediate directories for mirror paths", async () => {
    const stepOutput = makeStepOutput({ output: "Deep mirror content" });
    const stage = createStageDefinition({
      outputs: [
        createStageOutput({
          label: "planning_doc",
          format: "md",
          mirror_to: [".bees/deep/nested/file.md"],
        }),
      ],
    });
    const task = createTestTask({ workspacePath: workspaceDir });
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    await normalizeOutput(stepOutput, stage, task, subtask, runsDir);

    const deepPath = path.join(workspaceDir, ".bees", "deep", "nested", "file.md");
    const content = await readFile(deepPath, "utf-8");
    expect(content).toBe("Deep mirror content");
  });
});

// ---------------------------------------------------------------
// Group 7: Integration -- Full Handler Flow
// ---------------------------------------------------------------

describe("Integration -- Full Handler Flow", () => {
  it("full handler executes all four operations end-to-end", async () => {
    const roleContent = "You are a planning specialist.";
    const rolePath = path.join(runsDir, "roles", "planner.md");
    await writeRoleFile(rolePath, roleContent);

    const stage = createStageDefinition({
      role: rolePath,
      objective: "Create implementation plan",
      inputs: [createStageInput({ source: "task.payload.description" })],
      outputs: [createStageOutput({ label: "planning_doc", format: "md" })],
    });
    const recipe = createRecipeConfig({ stages: { planning: stage } });
    const task = createTestTask({ payload: { description: "build a widget" } });
    const subtask = createSubtask({ stageId: "planning" });
    await createTaskRunDir(task.id);

    const expectedOutput = makeStepOutput({ output: "Generated plan content" });
    const backend = makeStubBackend("cli-claude", expectedOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    const result = await handleStageAgentRun(task, subtask, recipe, runsDir);

    expect(backend.run).toHaveBeenCalledOnce();
    expect(result.output).toBe("Generated plan content");
    expect(result.artifactIds.length).toBeGreaterThan(0);

    const artifactsDir = path.join(runsDir, task.id, "artifacts");
    const artifactFiles = await readdir(artifactsDir);
    expect(artifactFiles.length).toBeGreaterThan(0);

    const journal = readJournal(runsDir, task.id);
    const artifactEntries = journal.filter((e) => e.type === "artifact_registered");
    expect(artifactEntries.length).toBeGreaterThan(0);
  });

  it("handler returns result enabling worker to queue next orchestrator_eval", async () => {
    const rolePath = path.join(runsDir, "roles", "planner.md");
    await writeRoleFile(rolePath, "You are a planner.");

    const stage = createStageDefinition({ role: rolePath });
    const recipe = createRecipeConfig({ stages: { planning: stage } });
    const task = createTestTask();
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    const backend = makeStubBackend("cli-claude", makeStepOutput({ output: "Plan done" }));
    mockResolveAgentBackend.mockReturnValue(backend);

    const result = await handleStageAgentRun(task, subtask, recipe, runsDir);

    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("artifactIds");
    expect(typeof result.output).toBe("string");
    expect(Array.isArray(result.artifactIds)).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("handler handles backend failure gracefully", async () => {
    const rolePath = path.join(runsDir, "roles", "planner.md");
    await writeRoleFile(rolePath, "You are a planner.");

    const stage = createStageDefinition({ role: rolePath });
    const recipe = createRecipeConfig({ stages: { planning: stage } });
    const task = createTestTask();
    const subtask = createSubtask();
    await createTaskRunDir(task.id);

    const backend = makeStubBackend("cli-claude");
    (backend.run as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("CLI worker timeout after 120s"),
    );
    mockResolveAgentBackend.mockReturnValue(backend);

    await expect(
      handleStageAgentRun(task, subtask, recipe, runsDir),
    ).rejects.toThrow("CLI worker timeout after 120s");
  });
});

// ---------------------------------------------------------------
// Shared helper: create a completed script_run subtask fixture
// ---------------------------------------------------------------

/** Factory for a completed script_run subtask with configurable script_id and output. */
function createScriptRunSubtask(overrides?: Partial<Subtask>): Subtask {
  return {
    id: "task-001-script-0",
    stepId: "planning",
    name: "script_run:knowledge.prime",
    executionType: "script",
    status: "completed",
    cost: zeroCost(),
    attempt: 1,
    maxRetries: 0,
    kind: "script_run",
    stageId: "planning",
    payload: { script_id: "knowledge.prime" },
    output: "Knowledge context primed successfully",
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Group 8: findLatestScriptOutput -- Script Output Lookup
// ---------------------------------------------------------------

describe("findLatestScriptOutput -- Script Output Lookup", () => {
  it("returns structured output from latest completed script_run subtask", () => {
    const scriptSubtask = createScriptRunSubtask({
      id: "task-001-script-1",
      payload: { script_id: "knowledge.prime" },
      output: "Knowledge context primed successfully",
    });
    const task = createTestTask({ subtasks: [scriptSubtask] });

    const result = findLatestScriptOutput(task, "knowledge.prime");

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Knowledge context primed successfully");
    expect(result!.scriptId).toBe("knowledge.prime");
    expect(result!.subtaskId).toBe("task-001-script-1");
  });

  it("returns null when no matching script_run subtask exists", () => {
    const scriptSubtask = createScriptRunSubtask({
      payload: { script_id: "data.extract" },
      output: "Data extracted",
    });
    const task = createTestTask({ subtasks: [scriptSubtask] });

    const result = findLatestScriptOutput(task, "knowledge.prime");

    expect(result).toBeNull();
  });

  it("returns null when subtasks array is empty or undefined", () => {
    const taskEmpty = createTestTask({ subtasks: [] });
    const taskUndefined = createTestTask({ subtasks: undefined });

    expect(findLatestScriptOutput(taskEmpty, "knowledge.prime")).toBeNull();
    expect(findLatestScriptOutput(taskUndefined, "knowledge.prime")).toBeNull();
  });

  it("returns the most recent match when multiple completed script_runs exist", () => {
    const older = createScriptRunSubtask({
      id: "task-001-script-1",
      payload: { script_id: "knowledge.prime" },
      output: "First run output",
    });
    const newer = createScriptRunSubtask({
      id: "task-001-script-3",
      payload: { script_id: "knowledge.prime" },
      output: "Second run output",
    });
    const task = createTestTask({ subtasks: [older, newer] });

    const result = findLatestScriptOutput(task, "knowledge.prime");

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Second run output");
    expect(result!.subtaskId).toBe("task-001-script-3");
  });

  it("ignores script_run subtasks that are not completed", () => {
    const failedSubtask = createScriptRunSubtask({
      id: "task-001-script-1",
      status: "failed",
      payload: { script_id: "knowledge.prime" },
      output: "Failed output",
    });
    const pendingSubtask = createScriptRunSubtask({
      id: "task-001-script-2",
      status: "pending",
      payload: { script_id: "knowledge.prime" },
      output: undefined,
    });
    const task = createTestTask({ subtasks: [failedSubtask, pendingSubtask] });

    const result = findLatestScriptOutput(task, "knowledge.prime");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------
// Group 9: resolveInputs -- Script Output Reference Resolution
// ---------------------------------------------------------------

describe("resolveInputs -- Script Output Reference Resolution", () => {
  it("resolves _script_output reference from inputPatch", () => {
    const scriptSubtask = createScriptRunSubtask({
      payload: { script_id: "some.script" },
      output: "Resolved script summary text",
    });
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptSubtask],
    });
    const inputPatch = { knowledge: { _script_output: "some.script" } };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.description).toBe("build a widget");
    expect(result.knowledge).not.toBeNull();
    expect(typeof result.knowledge).toBe("object");
    expect((result.knowledge as Record<string, unknown>).summary).toBe(
      "Resolved script summary text",
    );
  });

  it("passes through non-reference inputPatch values unchanged", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "build a widget" } });
    const inputPatch = {
      context: "plain string",
      count: 42,
      nested: { foo: "bar" },
    };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.context).toBe("plain string");
    expect(result.count).toBe(42);
    expect(result.nested).toEqual({ foo: "bar" });
  });

  it("resolves to null when referenced script has no completed output", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [],
    });
    const inputPatch = { data: { _script_output: "nonexistent.script" } };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.data).toBeNull();
  });

  it("handles multiple script output references in the same inputPatch", () => {
    const scriptA = createScriptRunSubtask({
      id: "task-001-script-a",
      payload: { script_id: "script.alpha" },
      output: "Alpha output",
    });
    const scriptB = createScriptRunSubtask({
      id: "task-001-script-b",
      payload: { script_id: "script.beta" },
      output: "Beta output",
    });
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptA, scriptB],
    });
    const inputPatch = {
      alpha_data: { _script_output: "script.alpha" },
      beta_data: { _script_output: "script.beta" },
    };

    const result = resolveInputs(stage, task, inputPatch);

    expect((result.alpha_data as Record<string, unknown>).summary).toBe("Alpha output");
    expect((result.beta_data as Record<string, unknown>).summary).toBe("Beta output");
  });

  it("existing resolveInputs behavior unchanged when no script references present", () => {
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({ payload: { description: "build a widget" } });
    const inputPatch = { extra_context: "additional notes" };

    const result = resolveInputs(stage, task, inputPatch);

    expect(result.description).toBe("build a widget");
    expect(result.extra_context).toBe("additional notes");
  });
});

// ---------------------------------------------------------------
// Group 10: resolveInputs -- Script Output Injection Traceability
// ---------------------------------------------------------------

describe("resolveInputs -- Script Output Injection Traceability", () => {
  it("appends journal entry when script output reference is resolved", async () => {
    const scriptSubtask = createScriptRunSubtask({
      payload: { script_id: "knowledge.prime" },
      output: "Primed context",
    });
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptSubtask],
    });
    const inputPatch = { knowledge: { _script_output: "knowledge.prime" } };
    await createTaskRunDir(task.id);

    resolveInputs(stage, task, inputPatch, { runsDir, taskId: task.id });

    const journal = readJournal(runsDir, task.id);
    const injectionEntries = journal.filter(
      (e) => e.type === "script_output_injected",
    );
    expect(injectionEntries.length).toBe(1);
    expect(injectionEntries[0]).toHaveProperty("scriptId", "knowledge.prime");
  });

  it("skips journal when journalContext is not provided", async () => {
    const scriptSubtask = createScriptRunSubtask({
      payload: { script_id: "knowledge.prime" },
      output: "Primed context",
    });
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptSubtask],
    });
    const inputPatch = { knowledge: { _script_output: "knowledge.prime" } };
    await createTaskRunDir(task.id);

    resolveInputs(stage, task, inputPatch);

    const journal = readJournal(runsDir, task.id);
    expect(journal.length).toBe(0);
  });

  it("journal entry records injection details for auditability", async () => {
    const scriptSubtask = createScriptRunSubtask({
      id: "task-001-script-audit",
      payload: { script_id: "data.extract" },
      output: "Extracted data summary",
    });
    const stage = createStageDefinition({
      inputs: [createStageInput({ source: "task.payload.description" })],
    });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptSubtask],
    });
    const inputPatch = { extracted: { _script_output: "data.extract" } };
    await createTaskRunDir(task.id);

    resolveInputs(stage, task, inputPatch, { runsDir, taskId: task.id });

    const journal = readJournal(runsDir, task.id);
    const entry = journal.find((e) => e.type === "script_output_injected");
    expect(entry).toBeDefined();
    expect(entry!.scriptId).toBe("data.extract");
    expect(entry!.targetKey).toBe("extracted");
    expect(entry!.sourceSubtaskId).toBe("task-001-script-audit");
  });
});

// ---------------------------------------------------------------
// Group 11: Integration -- Script Result Injection via handleStageAgentRun
// ---------------------------------------------------------------

describe("Integration -- Script Result Injection via handleStageAgentRun", () => {
  it("handleStageAgentRun merges script output into stage-agent resolved inputs", async () => {
    const roleContent = "You are a coding specialist.";
    const rolePath = path.join(runsDir, "roles", "coder.md");
    await writeRoleFile(rolePath, roleContent);

    const scriptSubtask = createScriptRunSubtask({
      id: "task-001-script-prime",
      payload: { script_id: "knowledge.prime" },
      output: "Primed knowledge context for coding",
    });
    const stage = createStageDefinition({
      role: rolePath,
      objective: "Implement the feature",
      inputs: [createStageInput({ source: "task.payload.description" })],
      outputs: [createStageOutput({ label: "code_output", format: "ts" })],
    });
    const recipe = createRecipeConfig({ stages: { coding: stage } });
    const task = createTestTask({
      payload: { description: "build a widget" },
      subtasks: [scriptSubtask],
    });
    const subtask = createSubtask({
      stageId: "coding",
      payload: { knowledge: { _script_output: "knowledge.prime" } },
    });
    await createTaskRunDir(task.id);

    const expectedOutput = makeStepOutput({ output: "Generated code" });
    const backend = makeStubBackend("cli-claude", expectedOutput);
    mockResolveAgentBackend.mockReturnValue(backend);

    await handleStageAgentRun(task, subtask, recipe, runsDir);

    expect(backend.run).toHaveBeenCalledOnce();
    const [passedConfig] = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = passedConfig.systemPrompt as string;

    // The rendered prompt should contain the resolved script output summary,
    // not the raw reference object serialized as "[object Object]" or JSON
    expect(systemPrompt).toContain("Primed knowledge context for coding");
    expect(systemPrompt).not.toContain("_script_output");
    expect(systemPrompt).not.toContain("[object Object]");
  });
});
