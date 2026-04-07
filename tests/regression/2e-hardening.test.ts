import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScriptRegistry } from "../../src/scripts/registry.js";
import { loadRecipes } from "../../src/recipes/loader.js";

// ---------------------------------------------------------------------------
// Project root resolution for integration tests reading real files
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");
const RECIPES_DIR = path.join(PROJECT_ROOT, "recipes");
const ROLES_IMPL_DIR = path.join(PROJECT_ROOT, "roles", "implementation");
const ORCHESTRATOR_ROLE_PATH = path.join(
  PROJECT_ROOT,
  "roles",
  "orchestrators",
  "implementation.md",
);

// ---------------------------------------------------------------------------
// Mock infrastructure for worker-level tests (Groups 1, 2, 8)
// ---------------------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

const { mockHandleStageAgentRun } = vi.hoisted(() => ({
  mockHandleStageAgentRun: vi.fn(),
}));

vi.mock("../../src/runtime/stage-agent-handler.js", () => ({
  handleStageAgentRun: mockHandleStageAgentRun,
}));

const { mockHandleScriptRun } = vi.hoisted(() => ({
  mockHandleScriptRun: vi.fn(),
}));

vi.mock("../../src/runtime/script-handler.js", () => ({
  handleScriptRun: mockHandleScriptRun,
}));

const { mockCreateWorkspace } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
}));

vi.mock("../../src/utils/workspace.js", () => ({
  createWorkspace: mockCreateWorkspace,
}));

// Import modules under test (after mocks are registered)
import { runTask } from "../../src/runtime/worker.js";
import { readJournal } from "../../src/runtime/journal.js";
import {
  validateEvidenceStructure,
  validateDeliveryEvidence,
  DELIVERY_STEPS,
} from "../../src/runtime/live-run-evidence.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  StageDefinition,
} from "../../src/recipes/types.js";
import type { StepOutput, AgentBackend } from "../../src/runners/types.js";
import type { ScriptManifest } from "../../src/scripts/types.js";
import type { JournalEntry } from "../../src/runtime/journal.js";

// ---------------------------------------------------------------------------
// Shared worker-level test infrastructure
// ---------------------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-hardening-reg-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Zero-value cost accumulator for task fixtures.
 * @returns CostAccumulator with all counters at zero
 */
function zeroCost() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** All 10 stages from the new-implementation recipe in canonical order. */
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

/** Stages visited via run_stage_agent (excludes start stage). */
const STAGES_VIA_RUN_STAGE_AGENT = STAGE_ORDER.filter(
  (s) => s !== "planning_check",
);

/** Number of run_stage_agent decisions in a golden-path traversal. */
const STAGE_AGENT_DECISION_COUNT = STAGES_VIA_RUN_STAGE_AGENT.length;

/** Number of run_script decisions in a golden-path traversal. */
const SCRIPT_DECISION_COUNT = 2;

/**
 * Action-consuming decisions: run_stage_agent + run_script.
 * finish_run does not increment the action counter.
 */
const EXPECTED_ACTION_COUNT =
  STAGE_AGENT_DECISION_COUNT + SCRIPT_DECISION_COUNT;

/** Expected total number of stages in the recipe, derived from STAGE_ORDER. */
const EXPECTED_STAGE_COUNT = STAGE_ORDER.length;

/** Minimum number of script entries after manifest hardening. */
const MINIMUM_SCRIPT_ENTRIES = 11;

/**
 * Build stage definitions matching the real recipe topology.
 * @param rolesDir - Temp directory path for role file resolution
 * @returns Record mapping stage identifiers to their definitions
 */
function buildStageDefinitions(
  rolesDir: string,
): Record<string, StageDefinition> {
  return {
    planning_check: {
      role: path.join(rolesDir, "planning-check.md"),
      objective: "Evaluate request",
      inputs: [
        { description: "User request", source: "task.payload.description" },
      ],
      outputs: [{ label: "planning_check_result", format: "json" }],
      allowed_transitions: ["create_planning"],
      allowed_scripts: [],
    },
    create_planning: {
      role: path.join(rolesDir, "planning-create.md"),
      objective: "Produce implementation plan",
      inputs: [
        { description: "User request", source: "task.payload.description" },
      ],
      outputs: [{ label: "planning_doc", format: "md" }],
      allowed_transitions: ["historical_search", "planning_check"],
      allowed_scripts: [],
    },
    historical_search: {
      role: path.join(rolesDir, "historical-search.md"),
      objective: "Search repository history",
      inputs: [
        {
          description: "Planning document",
          source: "artifacts.planning_doc",
        },
      ],
      outputs: [{ label: "solution_path", format: "md" }],
      allowed_transitions: ["adjust_planning", "create_planning"],
      allowed_scripts: ["repo.search", "repo.git_history"],
    },
    adjust_planning: {
      role: path.join(rolesDir, "planning-adjust.md"),
      objective: "Adjust plan based on history",
      inputs: [
        {
          description: "Planning document",
          source: "artifacts.planning_doc",
        },
      ],
      outputs: [{ label: "adjusted_planning_doc", format: "md" }],
      allowed_transitions: ["prime_codebase", "create_planning"],
      allowed_scripts: [],
    },
    prime_codebase: {
      role: path.join(rolesDir, "codebase-map.md"),
      objective: "Map codebase structure",
      inputs: [
        {
          description: "Adjusted planning",
          source: "artifacts.adjusted_planning_doc",
        },
      ],
      outputs: [{ label: "codebase_map", format: "md" }],
      allowed_transitions: ["prime_knowledge", "adjust_planning"],
      allowed_scripts: ["repo.search", "repo.file_map"],
    },
    prime_knowledge: {
      role: path.join(rolesDir, "knowledge-synthesis.md"),
      objective: "Synthesize knowledge",
      inputs: [
        {
          description: "Adjusted planning",
          source: "artifacts.adjusted_planning_doc",
        },
      ],
      outputs: [{ label: "knowledge_context", format: "md" }],
      allowed_transitions: ["prime_guidelines"],
      allowed_scripts: ["knowledge.prime"],
    },
    prime_guidelines: {
      role: path.join(rolesDir, "guidelines.md"),
      objective: "Extract guidelines",
      inputs: [
        {
          description: "Knowledge context",
          source: "artifacts.knowledge_context",
        },
      ],
      outputs: [{ label: "guidelines_doc", format: "md" }],
      allowed_transitions: ["create_tasks"],
      allowed_scripts: [],
    },
    create_tasks: {
      role: path.join(rolesDir, "task-breakdown.md"),
      objective: "Break plan into tasks",
      inputs: [
        {
          description: "Adjusted planning",
          source: "artifacts.adjusted_planning_doc",
        },
      ],
      outputs: [{ label: "task_pack", format: "json" }],
      allowed_transitions: ["batch_implement", "adjust_planning"],
      allowed_scripts: [],
    },
    batch_implement: {
      role: path.join(rolesDir, "implementation-coordinator.md"),
      objective: "Execute batch implementation",
      inputs: [{ description: "Task pack", source: "artifacts.task_pack" }],
      outputs: [{ label: "implementation_result", format: "md" }],
      allowed_transitions: ["commit_and_pr", "create_tasks"],
      allowed_scripts: ["implementation.batch_bridge"],
    },
    commit_and_pr: {
      role: path.join(rolesDir, "delivery-coordinator.md"),
      objective: "Stage, commit, push, open draft PR",
      inputs: [
        {
          description: "Implementation result",
          source: "artifacts.implementation_result",
        },
      ],
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

/**
 * Build a RecipeConfig matching the 10-stage topology.
 * @returns RecipeConfig with roles pointing to runsDir temp directory
 */
function createRecipeFixture(): RecipeConfig {
  const rolesDir = path.join(runsDir, "roles");
  return {
    id: "new-implementation",
    name: "New Implementation",
    command: "/new-implementation",
    description: "Full implementation workflow",
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

/**
 * Build a task fixture for worker-level tests.
 * @param overrides - Optional partial Task fields to merge
 * @returns Task instance ready for runTask() execution
 */
function createTaskFixture(overrides?: Partial<Task>): Task {
  return {
    id: "hardening-reg-001",
    gate: "implementation",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "Regression test harness" },
    requestedBy: "test-user",
    sourceChannel: { platform: "slack", channelId: "C-test" },
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

/**
 * Build a StepOutput wrapping a JSON decision.
 * @param decision - Decision object to serialize as the output payload
 * @returns StepOutput with JSON-stringified decision
 */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return { output: JSON.stringify(decision), outputFiles: [] };
}

/**
 * Create a mock backend returning responses in sequence.
 * @param responses - Ordered StepOutput responses to return per call
 * @returns AgentBackend whose run() pops responses in FIFO order
 */
function createSequenceBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(
        `Sequence backend exhausted at call ${callIndex}`,
      );
    }
    return Promise.resolve(responses[callIndex++]);
  });
  return { name: "mock-backend", run: runFn };
}

/**
 * Write all role files needed by a recipe to the temp directory.
 * @param recipe - RecipeConfig whose role paths will be created as stub files
 */
async function writeRoleFiles(recipe: RecipeConfig): Promise<void> {
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

/**
 * Build a script registry with all scripts used in the golden-path.
 * @returns Map of script_id to ScriptManifest for all recipe-referenced scripts
 */
function createRegistryFixture(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();
  const scripts: ScriptManifest[] = [
    {
      script_id: "repo.search",
      description: "Search repository",
      runtime: "shell",
      path: "scripts/repo/search.sh",
      timeout_ms: 90000,
      retryable: true,
      side_effects: "read-only",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "repo.git_history",
      description: "Analyze git history",
      runtime: "shell",
      path: "scripts/repo/git_history.sh",
      timeout_ms: 60000,
      retryable: true,
      side_effects: "read-only",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "repo.file_map",
      description: "Map directory tree",
      runtime: "shell",
      path: "scripts/repo/file_map.sh",
      timeout_ms: 60000,
      retryable: true,
      side_effects: "read-only",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "knowledge.prime",
      description: "Prime knowledge context",
      runtime: "python",
      path: "scripts/knowledge/prime_knowledge.py",
      timeout_ms: 300000,
      retryable: true,
      side_effects: "read-only",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "implementation.batch_bridge",
      description: "Translate planning to task packs",
      runtime: "python",
      path: "scripts/implementation/bees_batch_bridge.py",
      timeout_ms: 120000,
      retryable: false,
      side_effects: "workspace-write",
      required_env: [],
      rerun_policy: "refuse",
    },
    {
      script_id: "delivery.stage_explicit",
      description: "Stage files",
      runtime: "internal",
      path: "src/delivery/stage-explicit.ts",
      timeout_ms: 60000,
      retryable: false,
      side_effects: "workspace-write",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "delivery.commit_with_trailers",
      description: "Create conventional commit",
      runtime: "internal",
      path: "src/delivery/commit-with-trailers.ts",
      timeout_ms: 60000,
      retryable: false,
      side_effects: "workspace-write",
      required_env: [],
      rerun_policy: "refuse",
    },
    {
      script_id: "delivery.push_branch",
      description: "Push branch",
      runtime: "internal",
      path: "src/delivery/push-branch.ts",
      timeout_ms: 60000,
      retryable: true,
      side_effects: "external-write",
      required_env: [],
      rerun_policy: "restart",
    },
    {
      script_id: "delivery.upsert_draft_pr",
      description: "Create or update draft PR",
      runtime: "internal",
      path: "src/delivery/upsert-draft-pr.ts",
      timeout_ms: 60000,
      retryable: true,
      side_effects: "external-write",
      required_env: [],
      rerun_policy: "restart",
    },
  ];
  for (const script of scripts) {
    registry.set(script.script_id, script);
  }
  return registry;
}

/**
 * Build the golden-path decision sequence: 12 decisions that walk
 * through all 10 stages with 2 script invocations, ending in finish_run.
 */
function buildGoldenPathDecisions(): StepOutput[] {
  return [
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "create_planning",
      reason: "Request requires new planning",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "historical_search",
      reason: "Planning complete, search for prior art",
    }),
    makeDecisionOutput({
      action: "run_script",
      script_id: "repo.search",
      reason: "Search for related patterns",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "adjust_planning",
      reason: "Historical context gathered",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_codebase",
      reason: "Plan adjusted, map codebase",
    }),
    makeDecisionOutput({
      action: "run_script",
      script_id: "repo.file_map",
      reason: "Map directory structure",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_knowledge",
      reason: "Codebase mapped, synthesize knowledge",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_guidelines",
      reason: "Knowledge synthesized",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "create_tasks",
      reason: "Guidelines ready",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "batch_implement",
      reason: "Tasks created, begin implementation",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "commit_and_pr",
      reason: "Implementation complete, deliver changes",
    }),
    makeDecisionOutput({
      action: "finish_run",
      reason: "Delivery complete",
    }),
  ];
}

/**
 * Configure all mocks for a golden-path traversal and return the backend.
 * @param recipe - RecipeConfig whose role files will be written and backend wired
 * @returns AgentBackend configured with the golden-path decision sequence
 */
async function setupGoldenPathMocks(
  recipe: RecipeConfig,
): Promise<AgentBackend> {
  await writeRoleFiles(recipe);

  const backend = createSequenceBackend(buildGoldenPathDecisions());
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
      statePatch: { [`${subtask.payload?.script_id}_completed`]: true },
    }),
  );

  mockCreateWorkspace.mockResolvedValue({
    success: true,
    branchName: "bees/hardening-test",
    workspacePath: "/tmp/workspace-hardening",
  });

  return backend;
}

// ===========================================================================
// Worker-Level Regression Tests (Groups 1, 2, 8)
//
// Groups 1, 2, and 8 share a single golden-path runTask() execution per
// test to avoid tripling mock setup and worker loop overhead. Each test
// within the shared describe block asserts one regression behavior against
// the same completed task state.
// ===========================================================================

describe("Worker-level regressions (shared golden-path execution)", () => {
  let task: Task;
  let recipe: RecipeConfig;

  beforeEach(async () => {
    recipe = createRecipeFixture();
    const registry = createRegistryFixture();
    await setupGoldenPathMocks(recipe);
    task = createTaskFixture({ repoPath: "/tmp/test-repo" });

    await runTask(task, recipe, runsDir, registry);
  });

  // -------------------------------------------------------------------------
  // Group 1: Artifact Count Correctness (RD-1 Regression)
  //
  // The start stage (planning_check) is visited only via orchestrator_eval,
  // which does not produce a stage-agent artifact. Correct count is 9.
  // -------------------------------------------------------------------------

  describe("Artifact count correctness (RD-1 regression)", () => {
    it("start stage via orchestrator_eval does not produce a stage-agent artifact", () => {
      expect(task.status).toBe("completed");
      expect(task.artifactIds).toBeDefined();
      expect(
        task.artifactIds!.length,
        `Expected ${STAGE_AGENT_DECISION_COUNT} artifacts (one per run_stage_agent), got ${task.artifactIds!.length}`,
      ).toBe(STAGE_AGENT_DECISION_COUNT);

      for (const stageId of STAGES_VIA_RUN_STAGE_AGENT) {
        expect(
          task.artifactIds,
          `Missing artifact for stage "${stageId}"`,
        ).toContain(`art-${stageId}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Group 2: Action Budget Tracking (RD-2 Regression)
  //
  // finish_run does not increment totalActionCount. Correct total is 11
  // (9 run_stage_agent + 2 run_script), not 12.
  // -------------------------------------------------------------------------

  describe("Action budget tracking (RD-2 regression)", () => {
    it("finish_run does not increment totalActionCount", () => {
      expect(task.status).toBe("completed");
      expect(
        task.totalActionCount,
        `Expected ${EXPECTED_ACTION_COUNT} actions (${STAGE_AGENT_DECISION_COUNT} stage + ${SCRIPT_DECISION_COUNT} script), got ${task.totalActionCount}`,
      ).toBe(EXPECTED_ACTION_COUNT);
      expect(
        task.totalActionCount!,
        "Action count should stay below budget limit",
      ).toBeLessThan(recipe.orchestrator.max_total_actions);
    });
  });

  // -------------------------------------------------------------------------
  // Group 8: Script Handler Argument Shape (TEST-1 Regression)
  //
  // The script handler's second argument is the subtask (with kind
  // "script_run"), not stdin data. The task argument carries the payload.
  // -------------------------------------------------------------------------

  describe("Script handler argument shape (TEST-1 regression)", () => {
    it("script handler receives context object with taskPayload as third argument", () => {
      expect(mockHandleScriptRun).toHaveBeenCalled();

      const firstScriptCall = mockHandleScriptRun.mock.calls[0];
      expect(firstScriptCall).toBeDefined();

      // Second argument (index 1) is the subtask, not stdin data
      const subtaskArg = firstScriptCall[1];
      expect(subtaskArg).toHaveProperty("kind", "script_run");

      // First argument (index 0) is the task with id and payload
      const taskArg = firstScriptCall[0];
      expect(taskArg).toHaveProperty("id", task.id);
      expect(
        taskArg,
        "Task argument must carry payload for downstream consumption",
      ).toHaveProperty("payload");
    });
  });
});

// ===========================================================================
// Group 3: Role File Heading Safety (ROLE-1, ROLE-2 Regression)
//
// Validates that no role file in roles/implementation/ uses headings that
// would trigger anti-pattern checks via substring matching.
// ===========================================================================

describe("Role file heading safety (ROLE-1, ROLE-2 regression)", () => {
  it("no role file uses headings that trigger anti-pattern substring matches", () => {
    const roleFiles = readdirSync(ROLES_IMPL_DIR).filter((f) =>
      f.endsWith(".md"),
    );

    expect(
      roleFiles.length,
      "Expected at least 10 role files in roles/implementation/",
    ).toBeGreaterThanOrEqual(10);

    for (const filename of roleFiles) {
      const filePath = path.join(ROLES_IMPL_DIR, filename);
      const content = readFileSync(filePath, "utf-8");

      expect(
        content,
        `${filename} contains dangerous "# Output" heading`,
      ).not.toMatch(/^# Output$/m);

      expect(
        content,
        `${filename} contains dangerous "# Task" heading`,
      ).not.toMatch(/^# Task$/m);
    }

    // Also check the orchestrator role file
    const orchContent = readFileSync(ORCHESTRATOR_ROLE_PATH, "utf-8");
    expect(
      orchContent,
      "Orchestrator role contains dangerous heading",
    ).not.toMatch(/^# Output$/m);
    expect(
      orchContent,
      "Orchestrator role contains dangerous heading",
    ).not.toMatch(/^# Task$/m);
  });
});

// ===========================================================================
// Group 4: Script Registration Completeness (SCRIPT-1 Regression)
//
// Validates that every script referenced in recipe.yaml allowed_scripts
// exists in manifest.yaml, and that the manifest has at least 11 entries.
// ===========================================================================

describe("Script registration completeness (SCRIPT-1 regression)", () => {
  it("all recipe-referenced scripts exist in the manifest registry", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    const recipes = await loadRecipes(RECIPES_DIR);

    const newImplRecipe = recipes.get("new-implementation");
    expect(newImplRecipe).toBeDefined();

    for (const [stageId, stageDef] of Object.entries(
      newImplRecipe!.stages,
    )) {
      for (const scriptId of stageDef.allowed_scripts) {
        expect(
          registry.has(scriptId),
          `Script "${scriptId}" referenced in stage "${stageId}" not found in manifest`,
        ).toBe(true);
      }
    }
  });

  it("manifest has at least 11 registered scripts", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    expect(
      registry.size,
      `Expected at least ${MINIMUM_SCRIPT_ENTRIES} scripts after hardening, got ${registry.size}`,
    ).toBeGreaterThanOrEqual(MINIMUM_SCRIPT_ENTRIES);
  });
});

// ===========================================================================
// Group 5: Orchestrator Notes Quality (SCRIPT-2 Regression)
//
// Validates that every manifest entry's orchestrator_notes contains
// anti-pattern guidance (negative "Do not" instruction).
// ===========================================================================

describe("Orchestrator notes quality (SCRIPT-2 regression)", () => {
  it("all script orchestrator_notes contain anti-pattern guidance", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const [scriptId, manifest] of registry) {
      expect(
        manifest.orchestrator_notes,
        `Script "${scriptId}" is missing orchestrator_notes`,
      ).toBeDefined();

      expect(
        manifest.orchestrator_notes!.includes("Do not"),
        `Script "${scriptId}" orchestrator_notes lacks anti-pattern "Do not" guidance`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// Group 6: Recipe 10-Stage Completeness (RECIPE-1 Regression)
//
// Validates that the recipe has exactly 10 stages and the start stage is
// planning_check.
// ===========================================================================

describe("Recipe 10-stage completeness (RECIPE-1 regression)", () => {
  it("recipe defines exactly 10 stages", async () => {
    const recipes = await loadRecipes(RECIPES_DIR);
    const recipe = recipes.get("new-implementation");
    expect(recipe).toBeDefined();

    expect(
      recipe!.stage_order.length,
      `stage_order should have ${EXPECTED_STAGE_COUNT} entries, got ${recipe!.stage_order.length}`,
    ).toBe(EXPECTED_STAGE_COUNT);
    expect(
      Object.keys(recipe!.stages).length,
      `stages map should have ${EXPECTED_STAGE_COUNT} definitions, got ${Object.keys(recipe!.stages).length}`,
    ).toBe(EXPECTED_STAGE_COUNT);

    for (const stageId of STAGE_ORDER) {
      expect(
        recipe!.stages[stageId],
        `Expected stage "${stageId}" to exist in recipe`,
      ).toBeDefined();
    }
  });

  it("start stage is planning_check", async () => {
    const recipes = await loadRecipes(RECIPES_DIR);
    const recipe = recipes.get("new-implementation");
    expect(recipe).toBeDefined();
    expect(
      recipe!.start_stage,
      `start_stage should be "planning_check", got "${recipe!.start_stage}"`,
    ).toBe("planning_check");
  });
});

// ===========================================================================
// Group 7: Script Redistribution Integrity (RECIPE-2 Regression)
//
// Validates that scripts were correctly redistributed to their target stages
// after the recipe expansion from 2 to 10 stages.
// ===========================================================================

describe("Script redistribution integrity (RECIPE-2 regression)", () => {
  it("knowledge.prime is allowed only in prime_knowledge stage", async () => {
    const recipes = await loadRecipes(RECIPES_DIR);
    const recipe = recipes.get("new-implementation");
    expect(recipe).toBeDefined();

    for (const [stageId, stageDef] of Object.entries(recipe!.stages)) {
      if (stageId === "prime_knowledge") {
        expect(
          stageDef.allowed_scripts,
          "prime_knowledge should allow knowledge.prime",
        ).toContain("knowledge.prime");
      } else {
        expect(
          stageDef.allowed_scripts,
          `Stage "${stageId}" should not allow knowledge.prime`,
        ).not.toContain("knowledge.prime");
      }
    }
  });

  it("implementation.batch_bridge is allowed only in batch_implement stage", async () => {
    const recipes = await loadRecipes(RECIPES_DIR);
    const recipe = recipes.get("new-implementation");
    expect(recipe).toBeDefined();

    for (const [stageId, stageDef] of Object.entries(recipe!.stages)) {
      if (stageId === "batch_implement") {
        expect(
          stageDef.allowed_scripts,
          "batch_implement should allow implementation.batch_bridge",
        ).toContain("implementation.batch_bridge");
      } else {
        expect(
          stageDef.allowed_scripts,
          `Stage "${stageId}" should not allow implementation.batch_bridge`,
        ).not.toContain("implementation.batch_bridge");
      }
    }
  });
});

// ===========================================================================
// Group 9: Evidence Validation (T-009 Module Regression)
//
// Validates the live-run-evidence module behavior:
// - task_completed counts as completion; task_failed does not
// - validateDeliveryEvidence uses DELIVERY_STEPS for step validation
// ===========================================================================

describe("Evidence validation (T-009 module regression)", () => {
  it("validateEvidenceStructure counts task_completed but not task_failed as completion", () => {
    const journalWithFailed: JournalEntry[] = [
      {
        timestamp: "2026-04-07T00:00:00Z",
        type: "subtask_queued",
        stageId: "planning_check",
      },
      {
        timestamp: "2026-04-07T00:00:01Z",
        type: "orchestrator_decision",
        target_stage: "create_planning",
      },
      {
        timestamp: "2026-04-07T00:00:02Z",
        type: "task_failed",
        reason: "Unrecoverable error",
      },
    ];

    const result = validateEvidenceStructure(journalWithFailed, [
      ...STAGE_ORDER,
    ]);

    expect(
      result.hasCompletionEntry,
      "task_failed should not count as a completion entry",
    ).toBe(false);
    expect(
      result.valid,
      "Evidence should be invalid when only task_failed is present",
    ).toBe(false);
  });

  it("validateDeliveryEvidence uses DELIVERY_STEPS for step validation and detects failed steps", () => {
    expect(
      DELIVERY_STEPS,
      "DELIVERY_STEPS should define the 4 canonical delivery pipeline actions",
    ).toEqual(["stage", "commit", "push", "pr"]);
    expect(DELIVERY_STEPS.length).toBe(4);

    const taskState: Partial<Task> = {
      branchName: "bees/test-branch",
      prUrl: "https://github.com/org/repo/pull/99",
      prNumber: 99,
      deliveryStatus: {
        stage: "completed",
        commit: "completed",
        push: "failed",
        pr: "pending",
      },
    };

    const result = validateDeliveryEvidence(taskState);

    expect(result.valid, "Delivery should be invalid with failed steps").toBe(false);
    expect(result.allStepsCompleted, "Not all steps completed when push failed").toBe(false);
    expect(result.failedSteps, "Push step should appear in failedSteps").toContain("push");
    expect(
      result.failedSteps.length,
      `Expected exactly 1 failed step, got ${result.failedSteps.length}`,
    ).toBe(1);
  });
});
