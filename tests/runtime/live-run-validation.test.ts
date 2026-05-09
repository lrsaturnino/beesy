import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock the registry module so tests control the CLI backend
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

// ---------------------------------------------------------------
// Mock the stage-agent-handler for isolation
// ---------------------------------------------------------------

const { mockHandleStageAgentRun } = vi.hoisted(() => ({
  mockHandleStageAgentRun: vi.fn(),
}));

vi.mock("../../src/runtime/stage-agent-handler.js", () => ({
  handleStageAgentRun: mockHandleStageAgentRun,
}));

// ---------------------------------------------------------------
// Mock the script-handler for script_run dispatch isolation
// ---------------------------------------------------------------

const { mockHandleScriptRun } = vi.hoisted(() => ({
  mockHandleScriptRun: vi.fn(),
}));

vi.mock("../../src/runtime/script-handler.js", () => ({
  handleScriptRun: mockHandleScriptRun,
}));

// ---------------------------------------------------------------
// Mock the workspace module for workspace wiring isolation
// ---------------------------------------------------------------

const { mockCreateWorkspace } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
}));

vi.mock("../../src/utils/workspace.js", () => ({
  createWorkspace: mockCreateWorkspace,
}));

// Import modules under test
import { runTask } from "../../src/runtime/worker.js";
import {
  resumeTask,
  checkTimeouts,
  DEFAULT_RESUME_TIMEOUT_MS,
} from "../../src/runtime/pause-controller.js";

// Import real dependency modules used for assertions
import { readJournal } from "../../src/runtime/journal.js";
import { persistTask, loadTask } from "../../src/runtime/task-state.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  StageDefinition,
} from "../../src/recipes/types.js";
import type { StepOutput, AgentBackend } from "../../src/runners/types.js";
import type { ScriptManifest } from "../../src/scripts/types.js";

// Import the live-run evidence validator (does not exist yet -- RED phase)
import {
  validatePreRunEnvironment,
  validateEvidenceStructure,
  validateOperatorInterventions,
  validateDeliveryEvidence,
  type PreRunValidationResult,
  type EvidenceValidationResult,
} from "../../src/runtime/live-run-evidence.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-live-run-test-"));
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

// ---------------------------------------------------------------
// Stage topology matching recipes/new-implementation/recipe.yaml
// ---------------------------------------------------------------

const STAGE_ORDER = [
  "planning_check",
  "create_planning",
  "historical_search",
  "adjust_planning",
  "prime_codebase",
  "prime_knowledge",
  "prime_guidelines",
  "create_tasks",
  "batch_implement",
  "commit_and_pr",
] as const;

/** Stages that trigger operator checkpoints via pause_for_input. */
const CHECKPOINT_STAGES = ["historical_search", "create_tasks"] as const;

/** Build stage definitions matching the real recipe topology. */
function buildStageDefinitions(rolesDir: string): Record<string, StageDefinition> {
  return {
    planning_check: {
      role: path.join(rolesDir, "planning-check.md"),
      objective: "Evaluate the request and determine whether new planning is required",
      inputs: [{ description: "User request", source: "task.payload.description" }],
      outputs: [{ label: "planning_check_result", format: "json" }],
      allowed_transitions: ["create_planning"],
      allowed_scripts: [],
    },
    create_planning: {
      role: path.join(rolesDir, "planning-create.md"),
      objective: "Analyze the request and produce an implementation plan",
      inputs: [
        { description: "User request", source: "task.payload.description" },
        { description: "Planning check result", source: "artifacts.planning_check_result" },
      ],
      outputs: [{ label: "planning_doc", format: "md" }],
      allowed_transitions: ["historical_search", "planning_check"],
      allowed_scripts: [],
    },
    historical_search: {
      role: path.join(rolesDir, "historical-search.md"),
      objective: "Search repository history for prior solutions and relevant context",
      inputs: [{ description: "Planning document", source: "artifacts.planning_doc" }],
      outputs: [{ label: "solution_path", format: "md" }],
      allowed_transitions: ["adjust_planning", "create_planning"],
      allowed_scripts: ["repo.search", "repo.git_history"],
    },
    adjust_planning: {
      role: path.join(rolesDir, "planning-adjust.md"),
      objective: "Adjust the implementation plan based on historical findings",
      inputs: [
        { description: "Planning document", source: "artifacts.planning_doc" },
        { description: "Historical search findings", source: "artifacts.solution_path" },
      ],
      outputs: [{ label: "adjusted_planning_doc", format: "md" }],
      allowed_transitions: ["prime_codebase", "create_planning"],
      allowed_scripts: [],
    },
    prime_codebase: {
      role: path.join(rolesDir, "codebase-map.md"),
      objective: "Map codebase structure and locate files relevant to the plan",
      inputs: [{ description: "Adjusted planning document", source: "artifacts.adjusted_planning_doc" }],
      outputs: [{ label: "codebase_map", format: "md" }],
      allowed_transitions: ["prime_knowledge", "adjust_planning"],
      allowed_scripts: ["repo.search", "repo.file_map"],
    },
    prime_knowledge: {
      role: path.join(rolesDir, "knowledge-synthesis.md"),
      objective: "Synthesize knowledge context from codebase and planning artifacts",
      inputs: [
        { description: "Adjusted planning document", source: "artifacts.adjusted_planning_doc" },
        { description: "Codebase map", source: "artifacts.codebase_map" },
      ],
      outputs: [{ label: "knowledge_context", format: "md" }],
      allowed_transitions: ["prime_guidelines"],
      allowed_scripts: ["knowledge.prime"],
    },
    prime_guidelines: {
      role: path.join(rolesDir, "guidelines.md"),
      objective: "Extract and consolidate coding guidelines and conventions",
      inputs: [{ description: "Knowledge context", source: "artifacts.knowledge_context" }],
      outputs: [{ label: "guidelines_doc", format: "md" }],
      allowed_transitions: ["create_tasks"],
      allowed_scripts: [],
    },
    create_tasks: {
      role: path.join(rolesDir, "task-breakdown.md"),
      objective: "Break the plan into discrete implementation tasks",
      inputs: [
        { description: "Adjusted planning document", source: "artifacts.adjusted_planning_doc" },
        { description: "Codebase map", source: "artifacts.codebase_map" },
        { description: "Guidelines document", source: "artifacts.guidelines_doc" },
      ],
      outputs: [{ label: "task_pack", format: "json" }],
      allowed_transitions: ["batch_implement", "adjust_planning"],
      allowed_scripts: [],
    },
    batch_implement: {
      role: path.join(rolesDir, "implementation-coordinator.md"),
      objective: "Execute batch implementation of the task pack",
      inputs: [{ description: "Task pack", source: "artifacts.task_pack" }],
      outputs: [{ label: "implementation_result", format: "md" }],
      allowed_transitions: ["commit_and_pr", "create_tasks"],
      allowed_scripts: ["implementation.batch_bridge"],
    },
    commit_and_pr: {
      role: path.join(rolesDir, "delivery-coordinator.md"),
      objective: "Stage changes, create commit, push branch, and open draft PR",
      inputs: [{ description: "Implementation result from batch stage", source: "artifacts.implementation_result" }],
      outputs: [{ label: "pr_url", format: "url" }],
      allowed_transitions: [],
      allowed_scripts: [
        "delivery.stage_explicit",
        "delivery.commit_with_trailers",
        "delivery.push_branch",
        "delivery.upsert_draft_pr",
      ],
    },
  };
}

/** Build a RecipeConfig matching new-implementation/recipe.yaml. */
function createLiveRunRecipe(): RecipeConfig {
  const rolesDir = path.join(runsDir, "roles");
  return {
    id: "new-implementation",
    name: "New Implementation",
    command: "/new-implementation",
    description: "Full implementation workflow from planning through code delivery",
    orchestrator: {
      role: path.join(rolesDir, "orchestrator.md"),
      backend: "cli-claude",
      model: "anthropic/claude-sonnet-4-20250514",
      effort: "high",
      timeout_ms: 180000,
      max_stage_retries: 2,
      max_total_actions: 40,
    },
    stage_order: [...STAGE_ORDER],
    start_stage: "planning_check",
    stages: buildStageDefinitions(rolesDir),
  };
}

/** Build a task fixture for live-run testing. */
function createLiveRunTask(overrides?: Partial<Task>): Task {
  return {
    id: "live-run-001",
    gate: "implementation",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "Add bounded tBTC feature for live-run validation" },
    requestedBy: "operator-1",
    sourceChannel: { platform: "slack", channelId: "C-live" },
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    recipeId: "new-implementation",
    currentStageId: "planning_check",
    stageRetryCount: {},
    totalActionCount: 0,
    ...overrides,
  };
}

/** Build a StepOutput wrapping a JSON decision string. */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return {
    output: JSON.stringify(decision),
    outputFiles: [],
  };
}

/** Create a mock AgentBackend that returns responses in order. */
function createMockBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(`Mock backend exhausted: no response for call ${callIndex}`);
    }
    return Promise.resolve(responses[callIndex++]);
  });
  return { name: "mock-backend", run: runFn };
}

/** Write all role files needed by the recipe. */
async function writeAllRoleFiles(recipe: RecipeConfig): Promise<void> {
  const paths = new Set<string>();
  paths.add(recipe.orchestrator.role);
  for (const stageDef of Object.values(recipe.stages)) {
    paths.add(stageDef.role);
  }
  for (const rolePath of paths) {
    await mkdir(path.dirname(rolePath), { recursive: true });
    await writeFile(rolePath, "You are a test agent.", "utf-8");
  }
}

/** Build the full 10-stage script registry. */
function createLiveRunRegistry(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();
  const scripts: ScriptManifest[] = [
    { script_id: "repo.search", description: "Search repository", runtime: "shell", path: "scripts/repo/search.sh", timeout_ms: 90000, retryable: true, side_effects: "read-only", required_env: [], rerun_policy: "restart" },
    { script_id: "repo.git_history", description: "Analyze git history", runtime: "shell", path: "scripts/repo/git_history.sh", timeout_ms: 60000, retryable: true, side_effects: "read-only", required_env: [], rerun_policy: "restart" },
    { script_id: "repo.file_map", description: "Map directory tree", runtime: "shell", path: "scripts/repo/file_map.sh", timeout_ms: 60000, retryable: true, side_effects: "read-only", required_env: [], rerun_policy: "restart" },
    { script_id: "knowledge.prime", description: "Prime knowledge context", runtime: "python", path: "scripts/knowledge/prime_knowledge.py", timeout_ms: 300000, retryable: true, side_effects: "read-only", required_env: [], rerun_policy: "restart" },
    { script_id: "implementation.batch_bridge", description: "Translate planning to task packs", runtime: "python", path: "scripts/implementation/bees_batch_bridge.py", timeout_ms: 120000, retryable: false, side_effects: "workspace-write", required_env: [], rerun_policy: "refuse" },
    { script_id: "delivery.stage_explicit", description: "Stage files", runtime: "internal", path: "src/delivery/stage-explicit.ts", timeout_ms: 60000, retryable: false, side_effects: "workspace-write", required_env: [], rerun_policy: "restart" },
    { script_id: "delivery.commit_with_trailers", description: "Create conventional commit", runtime: "internal", path: "src/delivery/commit-with-trailers.ts", timeout_ms: 60000, retryable: false, side_effects: "workspace-write", required_env: [], rerun_policy: "refuse" },
    { script_id: "delivery.push_branch", description: "Push branch", runtime: "internal", path: "src/delivery/push-branch.ts", timeout_ms: 60000, retryable: true, side_effects: "external-write", required_env: [], rerun_policy: "restart" },
    { script_id: "delivery.upsert_draft_pr", description: "Create or update draft PR", runtime: "internal", path: "src/delivery/upsert-draft-pr.ts", timeout_ms: 60000, retryable: true, side_effects: "external-write", required_env: [], rerun_policy: "restart" },
  ];
  for (const script of scripts) {
    registry.set(script.script_id, script);
  }
  return registry;
}

// ---------------------------------------------------------------
// Pre-Run Environment Validation Tests
//
// Verifies that the environment prerequisites validation module
// correctly detects missing or invalid environment configuration
// before a live run is attempted.
// ---------------------------------------------------------------

describe("Pre-Run Environment Validation", () => {
  it("fails validation when ANTHROPIC_API_KEY is not set", async () => {
    const result = await validatePreRunEnvironment({
      requiredEnvVars: ["ANTHROPIC_API_KEY"],
      repoPath: "/tmp/test-repo",
      env: {},
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ANTHROPIC_API_KEY", reason: expect.stringContaining("missing") }),
    );
  });

  it("fails validation when GITHUB_TOKEN is not set", async () => {
    const result = await validatePreRunEnvironment({
      requiredEnvVars: ["GITHUB_TOKEN"],
      repoPath: "/tmp/test-repo",
      env: { ANTHROPIC_API_KEY: "sk-test-key" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "GITHUB_TOKEN", reason: expect.stringContaining("missing") }),
    );
  });

  it("fails validation when target repository path does not exist", async () => {
    const result = await validatePreRunEnvironment({
      requiredEnvVars: [],
      repoPath: "/nonexistent/path/to/repo",
      env: { ANTHROPIC_API_KEY: "sk-test", GITHUB_TOKEN: "ghp-test" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "repoPath", reason: expect.stringContaining("not accessible") }),
    );
  });

  it("passes validation when all prerequisites are met", async () => {
    const result = await validatePreRunEnvironment({
      requiredEnvVars: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
      repoPath: runsDir,
      env: { ANTHROPIC_API_KEY: "sk-test", GITHUB_TOKEN: "ghp-test" },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("collects multiple errors when several prerequisites are missing", async () => {
    const result = await validatePreRunEnvironment({
      requiredEnvVars: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
      repoPath: "/nonexistent/repo",
      env: {},
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------
// Evidence Structure Validation Tests
//
// Verifies that after a full run, the journal contains the
// expected entry types for a 10-stage traversal.
// ---------------------------------------------------------------

describe("Evidence Structure Validation", () => {
  it("validates journal contains required entry types for full traversal", async () => {
    const recipe = createLiveRunRecipe();
    const registry = createLiveRunRegistry();
    await writeAllRoleFiles(recipe);

    const backend = createMockBackend(buildCheckpointDecisions());
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockImplementation(
      async (_task: Task, subtask: { stageId?: string }) => ({
        output: `Stage ${subtask.stageId} completed`,
        artifactIds: [`art-${subtask.stageId}`],
      }),
    );
    mockHandleScriptRun.mockImplementation(
      async (_task: Task, subtask: { payload?: Record<string, unknown> }) => ({
        output: `Script ${subtask.payload?.script_id} completed`,
        artifactIds: [],
        statePatch: {},
      }),
    );
    mockCreateWorkspace.mockResolvedValue({
      success: true,
      branchName: "bees/live-run-001",
      workspacePath: "/tmp/live-workspace",
    });

    const task = createLiveRunTask({ repoPath: "/tmp/test-repo" });
    await runTask(task, recipe, runsDir, registry);

    const journal = readJournal(runsDir, task.id);
    const result = validateEvidenceStructure(journal, STAGE_ORDER as unknown as string[]);

    expect(result.valid).toBe(true);
    expect(result.stagesCovered).toEqual(expect.arrayContaining([...STAGE_ORDER]));
    expect(result.hasCompletionEntry).toBe(true);
  });

  it("detects missing stages in evidence when traversal is incomplete", async () => {
    const journal = [
      { timestamp: "2026-04-07T00:00:00Z", type: "subtask_queued", kind: "orchestrator_eval", stageId: "planning_check" },
      { timestamp: "2026-04-07T00:00:01Z", type: "orchestrator_decision", action: "run_stage_agent", target_stage: "create_planning" },
      { timestamp: "2026-04-07T00:00:02Z", type: "task_failed", reason: "API timeout" },
    ];

    const result = validateEvidenceStructure(journal, [...STAGE_ORDER]);

    expect(result.valid).toBe(false);
    expect(result.missingStages.length).toBeGreaterThan(0);
    expect(result.hasCompletionEntry).toBe(false);
  });
});

// ---------------------------------------------------------------
// Operator Intervention Validation Tests
//
// Verifies that pause/resume flow at checkpoint stages produces
// correctly shaped journal entries with human input captured.
// ---------------------------------------------------------------

describe("Operator Intervention Validation", () => {
  it("validates operator intervention entries have correct structure", async () => {
    const recipe = createLiveRunRecipe();
    await writeAllRoleFiles(recipe);

    // Build decisions that pause at historical_search checkpoint
    const decisions = [
      makeDecisionOutput({
        action: "run_stage_agent", target_stage: "create_planning",
        reason: "Request needs new planning",
      }),
      makeDecisionOutput({
        action: "pause_for_input", target_stage: "historical_search",
        reason: "Awaiting operator review of historical search results",
      }),
    ];

    const backend = createMockBackend(decisions);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockHandleStageAgentRun.mockResolvedValue({
      output: "Stage completed",
      artifactIds: ["art-create_planning"],
    });
    mockCreateWorkspace.mockResolvedValue({ success: true, branchName: "bees/test", workspacePath: "/tmp/ws" });

    const task = createLiveRunTask({ repoPath: "/tmp/test-repo" });
    await runTask(task, recipe, runsDir);

    expect(task.status).toBe("paused");

    // Simulate operator resume
    const resumed = await resumeTask(runsDir, task, "Historical findings look good, proceed with adjustment");
    expect(resumed).toBe(true);
    expect(task.status).toBe("active");

    const journal = readJournal(runsDir, task.id);
    const interventions = validateOperatorInterventions(journal);

    expect(interventions.pauseEntries.length).toBeGreaterThanOrEqual(1);
    expect(interventions.resumeEntries.length).toBeGreaterThanOrEqual(1);
    expect(interventions.resumeEntries[0]).toHaveProperty("humanInput");
    expect(typeof interventions.resumeEntries[0].humanInput).toBe("string");
    expect(interventions.resumeEntries[0].humanInput.length).toBeGreaterThan(0);
  });

  it("captures human input text on the task after resume", async () => {
    const recipe = createLiveRunRecipe();
    await writeAllRoleFiles(recipe);

    const decisions = [
      makeDecisionOutput({
        action: "pause_for_input", target_stage: "planning_check",
        reason: "Need operator input on approach",
      }),
    ];

    const backend = createMockBackend(decisions);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockCreateWorkspace.mockResolvedValue({ success: true, branchName: "bees/test", workspacePath: "/tmp/ws" });

    const task = createLiveRunTask();
    await runTask(task, recipe, runsDir);

    const humanInput = "Approved: proceed with the bounded feature implementation";
    await resumeTask(runsDir, task, humanInput);

    expect(task.capturedHumanContext).toBe(humanInput);

    const journal = readJournal(runsDir, task.id);
    const resumeEntries = journal.filter((e) => e.type === "task_resumed");
    expect(resumeEntries.length).toBe(1);
    expect(resumeEntries[0].humanInput).toBe(humanInput);
  });

  it("truncates long human input in journal entries to 500 chars", async () => {
    const recipe = createLiveRunRecipe();
    await writeAllRoleFiles(recipe);

    const decisions = [
      makeDecisionOutput({
        action: "pause_for_input", target_stage: "planning_check",
        reason: "Need operator review",
      }),
    ];

    const backend = createMockBackend(decisions);
    mockResolveAgentBackend.mockReturnValue(backend);
    mockCreateWorkspace.mockResolvedValue({ success: true, branchName: "bees/test", workspacePath: "/tmp/ws" });

    const task = createLiveRunTask();
    await runTask(task, recipe, runsDir);

    const longInput = "A".repeat(1000);
    await resumeTask(runsDir, task, longInput);

    const journal = readJournal(runsDir, task.id);
    const resumeEntry = journal.find((e) => e.type === "task_resumed");
    expect(resumeEntry).toBeDefined();
    expect((resumeEntry!.humanInput as string).length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------
// Delivery Evidence Validation Tests
//
// Verifies that delivery pipeline journal entries and task state
// contain the expected evidence for a complete delivery flow.
// ---------------------------------------------------------------

describe("Delivery Evidence Validation", () => {
  it("validates delivery evidence contains expected artifact fields", async () => {
    const taskState: Partial<Task> = {
      branchName: "bees/live-run-001",
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      deliveryStatus: {
        stage: "completed",
        commit: "completed",
        push: "completed",
        pr: "completed",
      },
    };

    const result = validateDeliveryEvidence(taskState);

    expect(result.valid).toBe(true);
    expect(result.hasBranch).toBe(true);
    expect(result.hasPrUrl).toBe(true);
    expect(result.hasPrNumber).toBe(true);
    expect(result.allStepsCompleted).toBe(true);
  });

  it("detects missing delivery fields in incomplete runs", async () => {
    const taskState: Partial<Task> = {
      branchName: "bees/live-run-001",
      deliveryStatus: {
        stage: "completed",
        commit: "completed",
        push: "failed",
      },
    };

    const result = validateDeliveryEvidence(taskState);

    expect(result.valid).toBe(false);
    expect(result.hasPrUrl).toBe(false);
    expect(result.hasPrNumber).toBe(false);
    expect(result.allStepsCompleted).toBe(false);
    expect(result.failedSteps).toContain("push");
  });

  it("detects completely absent delivery evidence", async () => {
    const taskState: Partial<Task> = {};

    const result = validateDeliveryEvidence(taskState);

    expect(result.valid).toBe(false);
    expect(result.hasBranch).toBe(false);
    expect(result.hasPrUrl).toBe(false);
    expect(result.allStepsCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------
// Checkpoint-aware decision sequences
// ---------------------------------------------------------------

/**
 * Build a decision sequence that walks through all 10 stages with
 * 2 script invocations and completes. This is the happy-path for
 * evidence validation (no checkpoint pauses in this variant -- those
 * are tested separately in operator intervention tests).
 */
function buildCheckpointDecisions(): StepOutput[] {
  return [
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "create_planning", reason: "Request requires planning" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "historical_search", reason: "Planning complete" }),
    makeDecisionOutput({ action: "run_script", script_id: "repo.search", reason: "Search for related patterns" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "adjust_planning", reason: "Historical context gathered" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "prime_codebase", reason: "Plan adjusted" }),
    makeDecisionOutput({ action: "run_script", script_id: "repo.file_map", reason: "Map directory structure" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "prime_knowledge", reason: "Codebase mapped" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "prime_guidelines", reason: "Knowledge synthesized" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "create_tasks", reason: "Guidelines ready" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "batch_implement", reason: "Tasks created" }),
    makeDecisionOutput({ action: "run_stage_agent", target_stage: "commit_and_pr", reason: "Implementation complete" }),
    makeDecisionOutput({ action: "finish_run", reason: "Delivery complete" }),
  ];
}
