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
import { readJournal } from "../../src/runtime/journal.js";

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
