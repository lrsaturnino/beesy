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

// Import module under test
import { runTask } from "../../src/runtime/worker.js";

// Import real dependency modules used for assertions
import { readJournal } from "../../src/runtime/journal.js";
import { loadTask } from "../../src/runtime/task-state.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  StageDefinition,
} from "../../src/recipes/types.js";
import type {
  StepOutput,
  AgentBackend,
} from "../../src/runners/types.js";
import type { ScriptManifest } from "../../src/scripts/types.js";

// ---------------------------------------------------------------
// Shared helpers and fixtures
// ---------------------------------------------------------------

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-golden-path-test-"));
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

/** All 10 stages from the new-implementation recipe in order. */
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

/** Stage definitions matching the real recipe topology. */
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
function createGoldenPathRecipe(): RecipeConfig {
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

/** Build a task fixture with realistic implementation request payload. */
function createGoldenPathTask(overrides?: Partial<Task>): Task {
  return {
    id: "golden-path-001",
    gate: "implementation",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "Add a utility function for formatting timestamps" },
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

/** Build a StepOutput wrapping a JSON decision string. */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return {
    output: JSON.stringify(decision),
    outputFiles: [],
  };
}

/**
 * Create a mock AgentBackend that returns responses in order.
 * Each call to run() pops the next response from the array.
 */
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

/** Build a script registry with the scripts used in the golden path. */
function createGoldenPathRegistry(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();

  const scripts: ScriptManifest[] = [
    {
      script_id: "repo.search",
      description: "Search repository files",
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
      description: "Analyze git log history",
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
      description: "Map directory tree structure",
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
      description: "Translate planning artifacts into task packs",
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
      description: "Stage specific files",
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
      description: "Push branch to remote",
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
 * Build the golden-path decision sequence: 12 decisions that walk through
 * all 10 stages with 2 script invocations.
 *
 * Sequence:
 *  1. (planning_check)     -> run_stage_agent(create_planning)
 *  2. (create_planning)    -> run_stage_agent(historical_search)
 *  3. (historical_search)  -> run_script(repo.search)
 *  4. (historical_search)  -> run_stage_agent(adjust_planning)
 *  5. (adjust_planning)    -> run_stage_agent(prime_codebase)
 *  6. (prime_codebase)     -> run_script(repo.file_map)
 *  7. (prime_codebase)     -> run_stage_agent(prime_knowledge)
 *  8. (prime_knowledge)    -> run_stage_agent(prime_guidelines)
 *  9. (prime_guidelines)   -> run_stage_agent(create_tasks)
 * 10. (create_tasks)       -> run_stage_agent(batch_implement)
 * 11. (batch_implement)    -> run_stage_agent(commit_and_pr)
 * 12. (commit_and_pr)      -> finish_run
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
      reason: "Search for related patterns in the repository",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "adjust_planning",
      reason: "Historical context gathered, adjust plan",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_codebase",
      reason: "Plan adjusted, map codebase structure",
    }),
    makeDecisionOutput({
      action: "run_script",
      script_id: "repo.file_map",
      reason: "Map directory structure for codebase priming",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_knowledge",
      reason: "Codebase mapped, synthesize knowledge context",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "prime_guidelines",
      reason: "Knowledge synthesized, extract coding guidelines",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "create_tasks",
      reason: "Guidelines ready, create task breakdown",
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
      reason: "Delivery complete, PR opened successfully",
    }),
  ];
}

/** Configure all mocks for a golden-path run. */
async function setupGoldenPathMocks(recipe: RecipeConfig): Promise<AgentBackend> {
  await writeAllRoleFiles(recipe);

  const backend = createMockBackend(buildGoldenPathDecisions());
  mockResolveAgentBackend.mockReturnValue(backend);

  // Stage handler returns traceable artifacts per stage
  mockHandleStageAgentRun.mockImplementation(
    async (task: Task, subtask: { stageId?: string }) => ({
      output: `Stage ${subtask.stageId} completed successfully`,
      artifactIds: [`art-${subtask.stageId}`],
    }),
  );

  // Script handler returns success results
  mockHandleScriptRun.mockImplementation(
    async (task: Task, subtask: { payload?: Record<string, unknown> }) => ({
      output: `Script ${subtask.payload?.script_id} completed`,
      artifactIds: [],
      statePatch: { [`${subtask.payload?.script_id}_completed`]: true },
    }),
  );

  // Workspace creation succeeds without real git ops
  mockCreateWorkspace.mockResolvedValue({
    success: true,
    branchName: "bees/dry-run-test",
    workspacePath: "/tmp/workspace-test",
  });

  return backend;
}

/**
 * Extract orchestrator decisions from journal entries.
 * Returns entries in journal order (chronological).
 */
function extractDecisions(journal: Array<{ type: string; [key: string]: unknown }>) {
  return journal.filter((e) => e.type === "orchestrator_decision");
}

/**
 * Extract the stage progression from run_stage_agent decisions.
 * Returns the ordered list of target_stage values.
 */
function extractStageProgression(journal: Array<{ type: string; [key: string]: unknown }>): string[] {
  return extractDecisions(journal)
    .filter((e) => e.action === "run_stage_agent")
    .map((e) => e.target_stage as string);
}

// ---------------------------------------------------------------
// Golden path derived constants
//
// These values are computed from the decision sequence and recipe
// topology so tests stay in sync with the golden-path data above.
// ---------------------------------------------------------------

/** Stages visited via run_stage_agent (excludes start stage visited via initial orchestrator_eval). */
const STAGES_VIA_RUN_STAGE_AGENT = STAGE_ORDER.filter((s) => s !== "planning_check");

/** Number of run_stage_agent decisions in the golden path. */
const STAGE_AGENT_DECISION_COUNT = STAGES_VIA_RUN_STAGE_AGENT.length; // 9

/** Number of run_script decisions in the golden path. */
const SCRIPT_DECISION_COUNT = 2;

/** Total orchestrator decisions: run_stage_agent + run_script + finish_run. */
const TOTAL_DECISION_COUNT = STAGE_AGENT_DECISION_COUNT + SCRIPT_DECISION_COUNT + 1; // 12

/** Action-consuming decisions: run_stage_agent + run_script (finish_run does not increment). */
const EXPECTED_ACTION_COUNT = STAGE_AGENT_DECISION_COUNT + SCRIPT_DECISION_COUNT; // 11

/**
 * Extract script invocations grouped by stage.
 *
 * Uses the stageId recorded on script_run subtask_queued journal entries
 * rather than proximity-based index heuristics. Returns a map from stageId
 * to the set of script_ids invoked at that stage.
 */
function extractScriptCallsByStage(
  journal: Array<{ type: string; [key: string]: unknown }>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const scriptQueuedEntries = journal.filter(
    (e) => e.type === "subtask_queued" && e.kind === "script_run",
  );
  for (const entry of scriptQueuedEntries) {
    const stageId = entry.stageId as string;
    const scriptId = entry.payload
      ? (entry.payload as Record<string, unknown>).script_id as string
      : "unknown";
    if (!result.has(stageId)) {
      result.set(stageId, new Set());
    }
    result.get(stageId)!.add(scriptId);
  }
  return result;
}

// ---------------------------------------------------------------
// Golden Path Execution (Groups 1-5)
//
// All golden-path tests share a single runTask() execution via
// beforeAll. This eliminates 10 redundant mock runs while keeping
// each assertion focused on one behavioral aspect.
// ---------------------------------------------------------------

describe("Golden Path Dry Run", () => {
  let task: Task;
  let recipe: RecipeConfig;
  let journal: Array<{ type: string; [key: string]: unknown }>;
  let decisions: Array<{ type: string; [key: string]: unknown }>;

  beforeEach(async () => {
    recipe = createGoldenPathRecipe();
    const registry = createGoldenPathRegistry();
    await setupGoldenPathMocks(recipe);
    task = createGoldenPathTask({ repoPath: "/tmp/test-repo" });

    await runTask(task, recipe, runsDir, registry);

    journal = readJournal(runsDir, task.id);
    decisions = extractDecisions(journal);
  });

  // ---------------------------------------------------------------
  // Group 1: Full 10-Stage Golden Path Traversal
  // ---------------------------------------------------------------

  describe("Full 10-Stage Traversal", () => {
    it("traverses all 10 stages from planning_check to commit_and_pr and completes", () => {
      expect(task.status).toBe("completed");
      expect(decisions.length).toBe(TOTAL_DECISION_COUNT);

      const rejections = journal.filter((e) => e.type === "decision_rejected");
      expect(rejections.length).toBe(0);
    });

    it("visits each stage exactly once in recipe topology order", () => {
      const stageProgression = extractStageProgression(journal);

      // The start stage (planning_check) is visited via the initial
      // orchestrator_eval, not via run_stage_agent, so the progression
      // begins at create_planning.
      expect(stageProgression).toEqual([...STAGES_VIA_RUN_STAGE_AGENT]);
    });

    it("produces artifacts at every stage that declares outputs", () => {
      expect(task.artifactIds).toBeDefined();
      expect(task.artifactIds!.length).toBe(STAGE_AGENT_DECISION_COUNT);

      for (const stageId of STAGES_VIA_RUN_STAGE_AGENT) {
        expect(task.artifactIds).toContain(`art-${stageId}`);
      }
    });
  });

  // ---------------------------------------------------------------
  // Group 2: Script Invocation Quality
  // ---------------------------------------------------------------

  describe("Script Invocation Quality", () => {
    it("scripts invoked only at stages with allowed_scripts", () => {
      const scriptSubtasks = journal.filter(
        (e) => e.type === "subtask_queued" && e.kind === "script_run",
      );

      for (const entry of scriptSubtasks) {
        const stageId = entry.stageId as string;
        const stageDef = recipe.stages[stageId];
        expect(stageDef).toBeDefined();
        expect(stageDef.allowed_scripts.length).toBeGreaterThan(0);
      }

      const rejections = journal.filter((e) => e.type === "decision_rejected");
      expect(rejections.length).toBe(0);
    });

    it("each script called at most once per stage visit", () => {
      const callsByStage = extractScriptCallsByStage(journal);

      // Verify that no stage has duplicate script invocations by confirming
      // the set size matches the number of queued script_run entries per stage
      const scriptQueuedEntries = journal.filter(
        (e) => e.type === "subtask_queued" && e.kind === "script_run",
      );
      const countPerStage = new Map<string, number>();
      for (const entry of scriptQueuedEntries) {
        const stageId = entry.stageId as string;
        countPerStage.set(stageId, (countPerStage.get(stageId) ?? 0) + 1);
      }

      for (const [stageId, scripts] of callsByStage) {
        expect(scripts.size).toBe(countPerStage.get(stageId));
      }
    });
  });

  // ---------------------------------------------------------------
  // Group 3: Orchestrator Decision Quality
  // ---------------------------------------------------------------

  describe("Orchestrator Decision Quality", () => {
    it("no aimless stage bouncing or thrashing detected", () => {
      const stageProgression = extractStageProgression(journal);

      const uniqueStages = new Set(stageProgression);
      expect(uniqueStages.size).toBe(stageProgression.length);
    });

    it("budget tracking increments correctly across full traversal", () => {
      expect(task.totalActionCount).toBe(EXPECTED_ACTION_COUNT);
      expect(task.totalActionCount!).toBeLessThan(recipe.orchestrator.max_total_actions);
    });

    it("decision reasons are present and non-empty", () => {
      for (const decision of decisions) {
        expect(decision.reason).toBeDefined();
        expect(typeof decision.reason).toBe("string");
        expect((decision.reason as string).length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------
  // Group 4: Evidence Preservation
  // ---------------------------------------------------------------

  describe("Evidence Preservation", () => {
    it("journal contains complete lifecycle trace", () => {
      const entryTypes = new Set(journal.map((e) => e.type));

      const requiredTypes = [
        "subtask_queued",
        "subtask_started",
        "orchestrator_decision",
        "subtask_completed",
        "task_completed",
      ];
      for (const requiredType of requiredTypes) {
        expect(entryTypes.has(requiredType)).toBe(true);
      }

      // Journal entries must be in chronological order (non-decreasing timestamps)
      for (let i = 1; i < journal.length; i++) {
        expect(journal[i].timestamp >= journal[i - 1].timestamp).toBe(true);
      }
    });

    it("task state persisted and recoverable after completion", async () => {
      const loaded = await loadTask(runsDir, task.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe("completed");
      expect(loaded!.subtasks!.length).toBeGreaterThan(0);
      expect(loaded!.completedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // Group 5: Sandbox Delivery Phase
  // ---------------------------------------------------------------

  describe("Sandbox Delivery Phase", () => {
    it("delivery stage commit_and_pr reached and produces finish_run", () => {
      const stageDecisions = decisions.filter((e) => e.action === "run_stage_agent");
      const lastStageDecision = stageDecisions[stageDecisions.length - 1];
      expect(lastStageDecision.target_stage).toBe("commit_and_pr");

      const finalDecision = decisions[decisions.length - 1];
      expect(finalDecision.action).toBe("finish_run");

      const completedEntries = journal.filter((e) => e.type === "task_completed");
      expect(completedEntries.length).toBe(1);
    });

    it("workspace creation mocked for sandbox isolation", () => {
      expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);

      expect(task.branchName).toBe("bees/dry-run-test");
      expect(task.workspacePath).toBe("/tmp/workspace-test");
    });
  });
});

// ---------------------------------------------------------------
// Group 6: Error Recovery Path (separate execution context)
// ---------------------------------------------------------------

describe("Error Recovery Path", () => {
  it("stage failure mid-run triggers recovery orchestrator_eval", async () => {
    const recipe = createGoldenPathRecipe();
    const registry = createGoldenPathRegistry();
    await writeAllRoleFiles(recipe);

    const task = createGoldenPathTask({ repoPath: "/tmp/test-repo" });

    const backend = createMockBackend([
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "create_planning",
        reason: "Start planning",
      }),
      makeDecisionOutput({
        action: "fail_run",
        reason: "Unrecoverable stage failure",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    mockHandleStageAgentRun.mockRejectedValueOnce(
      new Error("Stage agent crashed unexpectedly"),
    );

    mockCreateWorkspace.mockResolvedValue({
      success: true,
      branchName: "bees/dry-run-test",
      workspacePath: "/tmp/workspace-test",
    });

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("failed");

    const journal = readJournal(runsDir, task.id);

    const failures = journal.filter((e) => e.type === "subtask_failed");
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0].kind).toBe("stage_agent_run");

    // Backend called twice: initial orchestrator_eval + recovery eval after failure
    expect(backend.run).toHaveBeenCalledTimes(2);
  });
});
