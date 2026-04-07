import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Mock the CLI backend and script subprocess boundaries
// ---------------------------------------------------------------

const { mockResolveAgentBackend } = vi.hoisted(() => ({
  mockResolveAgentBackend: vi.fn(),
}));

vi.mock("../../src/runners/registry.js", () => ({
  resolveAgentBackend: mockResolveAgentBackend,
}));

const { mockRunScript } = vi.hoisted(() => ({
  mockRunScript: vi.fn(),
}));

vi.mock("../../src/executor/script-runner.js", () => ({
  runScript: mockRunScript,
}));

const { mockCreateWorkspace } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
}));

vi.mock("../../src/utils/workspace.js", () => ({
  createWorkspace: mockCreateWorkspace,
}));

// Import module under test (after mocks)
import { runTask } from "../../src/runtime/worker.js";

// Import real dependencies for assertions
import { readJournal } from "../../src/runtime/journal.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  OrchestratorConfig,
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
let workspacePath: string;

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-validation-"));
  workspacePath = await mkdtemp(path.join(tmpdir(), "bees-validation-ws-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Valid script result envelope for the health check script. */
function makeHealthCheckEnvelope(): string {
  return JSON.stringify({
    summary: "Health check passed: all 3 systems operational",
    outputs: {},
    state_patch: { health_status: "healthy" },
    metrics: { checks_run: 3, healthy_count: 3 },
  });
}

/** Valid script result envelope for the metrics aggregation script. */
function makeMetricsEnvelope(): string {
  return JSON.stringify({
    summary: "Metrics aggregated: 3 sources compiled",
    outputs: {},
    state_patch: { metrics_compiled: true },
    metrics: { sources: 3, total_datapoints: 42 },
  });
}

/** Build a StepOutput with a stringified JSON decision. */
function makeDecisionOutput(decision: Record<string, unknown>): StepOutput {
  return { output: JSON.stringify(decision), outputFiles: [] };
}

/** Build a StepOutput simulating a stage agent producing text output. */
function makeStageOutput(text: string): StepOutput {
  return { output: text, outputFiles: [] };
}

/** Build a StepOutput simulating a successful script run (exit code 0). */
function makeScriptOutput(envelope: string): StepOutput {
  return { output: envelope, outputFiles: [], exitCode: 0 };
}

/**
 * Create a mock backend whose run() returns responses in sequence.
 * Exhausting the sequence throws an error for easy diagnosis.
 */
function createSequenceBackend(responses: StepOutput[]): AgentBackend {
  let callIndex = 0;
  const runFn = vi.fn().mockImplementation(() => {
    if (callIndex >= responses.length) {
      throw new Error(`Sequence backend exhausted at call ${callIndex}`);
    }
    return Promise.resolve(responses[callIndex++]);
  });
  return { name: "mock-backend", run: runFn };
}

/** Factory for OrchestratorConfig pointing to temp directory role files. */
function createOrchestratorConfig(rolePath: string): OrchestratorConfig {
  return {
    role: rolePath,
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 120000,
    max_stage_retries: 2,
    max_total_actions: 20,
  };
}

/** Factory for a two-stage monitoring-pilot recipe with script allowlists. */
function createPilotRecipe(): RecipeConfig {
  const orchestratorRolePath = path.join(runsDir, "roles", "monitoring-pilot.md");
  const collectDataRolePath = path.join(runsDir, "roles", "collect-data.md");
  const analyzeRolePath = path.join(runsDir, "roles", "analyze.md");

  return {
    id: "monitoring-pilot",
    name: "Monitoring Pilot",
    command: "/monitoring-pilot",
    description: "Script-heavy monitoring recipe for validation",
    orchestrator: createOrchestratorConfig(orchestratorRolePath),
    stage_order: ["collect_data", "analyze"],
    start_stage: "collect_data",
    stages: {
      collect_data: {
        role: collectDataRolePath,
        objective: "Collect health and metric data from target systems via scripts",
        inputs: [
          { description: "Target system", source: "task.payload.target" },
        ],
        outputs: [],
        allowed_transitions: ["analyze"],
        allowed_scripts: ["monitoring.check_health", "monitoring.aggregate_metrics"],
      },
      analyze: {
        role: analyzeRolePath,
        objective: "Analyze collected monitoring data and produce a report",
        inputs: [
          { description: "Health data", source: "task.payload.health_summary" },
        ],
        outputs: [
          { label: "monitoring_report", format: "md" },
        ],
        allowed_transitions: [],
        allowed_scripts: [],
      },
    },
  };
}

/** Factory for a minimal valid Task matching the monitoring-pilot recipe. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-validation-001",
    gate: "monitoring-pilot",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { target: "production", description: "Validation run" },
    requestedBy: "user-validation",
    sourceChannel: { platform: "slack", channelId: "C-VAL" },
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    cost: zeroCost(),
    subtasks: [],
    queuedSubtaskIds: [],
    recipeId: "monitoring-pilot",
    currentStageId: "collect_data",
    stageRetryCount: {},
    totalActionCount: 0,
    workspacePath,
    ...overrides,
  };
}

/** Build a registry Map with the two pilot script manifests. */
function createPilotRegistry(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();

  registry.set("monitoring.check_health", {
    script_id: "monitoring.check_health",
    description: "Run health checks against target systems",
    runtime: "shell",
    path: "scripts/monitoring/check_health.sh",
    timeout_ms: 60000,
    retryable: true,
    side_effects: "read-only",
    required_env: [],
    orchestrator_notes: "Run in collect_data stage to gather health status",
    rerun_policy: "restart",
  });

  registry.set("monitoring.aggregate_metrics", {
    script_id: "monitoring.aggregate_metrics",
    description: "Aggregate monitoring metrics from collected data",
    runtime: "shell",
    path: "scripts/monitoring/aggregate_metrics.sh",
    timeout_ms: 60000,
    retryable: true,
    side_effects: "read-only",
    required_env: [],
    orchestrator_notes: "Run in collect_data stage after health check to compile metrics",
    rerun_policy: "restart",
  });

  return registry;
}

/** Write all role files needed for a recipe to temp directories. */
async function writeAllRoleFiles(recipe: RecipeConfig): Promise<void> {
  const orchDir = path.dirname(recipe.orchestrator.role);
  await mkdir(orchDir, { recursive: true });
  await writeFile(recipe.orchestrator.role, "You are a monitoring orchestrator.", "utf-8");

  for (const [stageId, stage] of Object.entries(recipe.stages)) {
    const stageDir = path.dirname(stage.role);
    await mkdir(stageDir, { recursive: true });
    await writeFile(stage.role, `You are a ${stageId} agent.`, "utf-8");
  }
}

/**
 * Standard validation test fixture: create recipe, write role files,
 * build task and registry. Does NOT configure mockRunScript -- individual
 * tests set their own mock responses for explicit test readability.
 */
async function setupPilotFixture(): Promise<{
  recipe: RecipeConfig;
  task: Task;
  registry: Map<string, ScriptManifest>;
}> {
  const recipe = createPilotRecipe();
  await writeAllRoleFiles(recipe);
  const task = createTestTask();
  const registry = createPilotRegistry();
  return { recipe, task, registry };
}

/**
 * Build a sequence backend for the common single-script-then-finish flow.
 * Used by tests that only need one script execution followed by task completion.
 */
function createSingleScriptBackend(
  scriptId: string,
  reason = "run health check",
): AgentBackend {
  return createSequenceBackend([
    makeDecisionOutput({ action: "run_script", script_id: scriptId, reason }),
    makeDecisionOutput({ action: "finish_run", reason: "done" }),
  ]);
}

/**
 * Build a sequence backend for the full monitoring-pilot flow:
 * check_health -> aggregate_metrics -> analyze (stage agent) -> finish.
 */
function createFullMonitoringBackend(): AgentBackend {
  return createSequenceBackend([
    makeDecisionOutput({
      action: "run_script",
      script_id: "monitoring.check_health",
      reason: "collect health data",
    }),
    makeDecisionOutput({
      action: "run_script",
      script_id: "monitoring.aggregate_metrics",
      reason: "aggregate metrics",
    }),
    makeDecisionOutput({
      action: "run_stage_agent",
      target_stage: "analyze",
      reason: "transition to analysis",
    }),
    makeStageOutput("# Monitoring Report\n\nAll systems healthy."),
    makeDecisionOutput({
      action: "finish_run",
      reason: "monitoring cycle complete",
    }),
  ]);
}

// ---------------------------------------------------------------
// Group 1: Orchestrator Intentionality
// ---------------------------------------------------------------

describe("Orchestrator intentionality", () => {
  it("orchestrator prompt contains script catalog with orchestrator_notes for intentional selection", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));

    const backend = createSingleScriptBackend("monitoring.check_health");
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Inspect the first orchestrator call prompt content
    const firstCall = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = firstCall[0].systemPrompt as string;

    // Verify catalog section presence with both script IDs
    expect(systemPrompt).toContain("Available Scripts:");
    expect(systemPrompt).toContain("monitoring.check_health");
    expect(systemPrompt).toContain("monitoring.aggregate_metrics");

    // Verify orchestrator_notes are included for intentional selection
    expect(systemPrompt).toContain("Run in collect_data stage to gather health status");
    expect(systemPrompt).toContain("Run in collect_data stage after health check to compile metrics");

    // Verify stage-scoped allowlist
    expect(systemPrompt).toContain("Allowed Scripts for This Stage:");
  });

  it("orchestrator chooses scripts matching stage allowlist (collect_data allows monitoring scripts, analyze allows none)", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));

    // Sequence: run script in collect_data -> transition to analyze -> stage agent output -> finish
    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "collect health data",
      }),
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "analyze",
        reason: "transition to analysis",
      }),
      makeStageOutput("# Monitoring Report\n\nAll systems healthy."),
      makeDecisionOutput({
        action: "finish_run",
        reason: "analysis complete",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify journal shows script_completed for check_health during collect_data
    const journal = readJournal(runsDir, task.id);
    const scriptCompleted = journal.find(
      (e) => e.type === "script_completed" && e.scriptId === "monitoring.check_health",
    );
    expect(scriptCompleted).toBeDefined();

    // Verify no script_run subtasks have stageId "analyze"
    const analyzeScriptSubs = (task.subtasks ?? []).filter(
      (s) => s.kind === "script_run" && s.stageId === "analyze",
    );
    expect(analyzeScriptSubs).toHaveLength(0);
  });

  it("orchestrator selects both monitoring scripts sequentially in collect_data stage", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript
      .mockResolvedValueOnce(makeScriptOutput(makeHealthCheckEnvelope()))
      .mockResolvedValueOnce(makeScriptOutput(makeMetricsEnvelope()));
    mockResolveAgentBackend.mockReturnValue(createFullMonitoringBackend());

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify both state_patch values merged into task.payload
    expect(task.payload).toHaveProperty("health_status", "healthy");
    expect(task.payload).toHaveProperty("metrics_compiled", true);

    // Verify journal has 2 script_completed entries with distinct scriptIds
    const journal = readJournal(runsDir, task.id);
    const scriptCompletedEntries = journal.filter((e) => e.type === "script_completed");
    expect(scriptCompletedEntries).toHaveLength(2);
    const completedScriptIds = scriptCompletedEntries.map((e) => e.scriptId);
    expect(completedScriptIds).toContain("monitoring.check_health");
    expect(completedScriptIds).toContain("monitoring.aggregate_metrics");
  });
});

// ---------------------------------------------------------------
// Group 2: Script Execution Quality
// ---------------------------------------------------------------

describe("Script execution quality", () => {
  it("script execution through worker produces clean exit with structured output", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));
    mockResolveAgentBackend.mockReturnValue(
      createSingleScriptBackend("monitoring.check_health"),
    );

    await runTask(task, recipe, runsDir, registry);

    // Verify script subtask completed cleanly (no error)
    const scriptSubtask = task.subtasks!.find((s) => s.kind === "script_run");
    expect(scriptSubtask).toBeDefined();
    expect(scriptSubtask!.status).toBe("completed");
    expect(scriptSubtask!.error).toBeUndefined();

    // Verify journal lifecycle events with correct scriptId
    const journal = readJournal(runsDir, task.id);
    const scriptStarted = journal.find(
      (e) => e.type === "script_started" && e.scriptId === "monitoring.check_health",
    );
    expect(scriptStarted).toBeDefined();

    const scriptCompleted = journal.find(
      (e) => e.type === "script_completed" && e.scriptId === "monitoring.check_health",
    );
    expect(scriptCompleted).toBeDefined();
    expect(scriptCompleted!.summary).toBe("Health check passed: all 3 systems operational");
    expect(scriptCompleted!.metrics).toBeDefined();
  });

  it("script state_patch is merged into task payload for downstream consumption", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));
    mockResolveAgentBackend.mockReturnValue(
      createSingleScriptBackend("monitoring.check_health"),
    );

    // Verify payload before execution does not have health_status
    expect(task.payload).not.toHaveProperty("health_status");

    await runTask(task, recipe, runsDir, registry);

    // Verify state_patch merged into task.payload after script completes
    expect(task.payload).toHaveProperty("health_status", "healthy");
  });

  it("script failure is handled gracefully without crashing the worker loop", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    // Script returns failure (exit code 1)
    mockRunScript.mockResolvedValue({
      output: "",
      outputFiles: [],
      error: "Script failed: connection refused",
      exitCode: 1,
    });

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "run health check",
      }),
      // After failure, orchestrator recovers by failing the run
      makeDecisionOutput({
        action: "fail_run",
        reason: "script failed, aborting",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Task should be failed (by orchestrator decision), not crashed
    expect(task.status).toBe("failed");

    // Verify script subtask marked failed
    const scriptSubtask = task.subtasks!.find((s) => s.kind === "script_run");
    expect(scriptSubtask).toBeDefined();
    expect(scriptSubtask!.status).toBe("failed");

    // Verify orchestrator got another eval after failure (backend.run called >= 2 times)
    expect((backend.run as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    // Verify journal has subtask_failed entry with script_run kind
    const journal = readJournal(runsDir, task.id);
    const subtaskFailed = journal.find(
      (e) => e.type === "subtask_failed" && e.kind === "script_run",
    );
    expect(subtaskFailed).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 3: Output Usefulness Without Delivery
// ---------------------------------------------------------------

describe("Output usefulness without delivery", () => {
  it("monitoring script output provides actionable data without repository delivery", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript
      .mockResolvedValueOnce(makeScriptOutput(makeHealthCheckEnvelope()))
      .mockResolvedValueOnce(makeScriptOutput(makeMetricsEnvelope()));
    mockResolveAgentBackend.mockReturnValue(createFullMonitoringBackend());

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify enriched payload contains data from scripts
    expect(task.payload).toHaveProperty("health_status", "healthy");
    expect(task.payload).toHaveProperty("metrics_compiled", true);

    // Verify journal has script_completed entries with state_patch data
    const journal = readJournal(runsDir, task.id);
    const scriptCompletedEntries = journal.filter((e) => e.type === "script_completed");
    expect(scriptCompletedEntries.length).toBeGreaterThanOrEqual(2);

    // Verify NO delivery-related journal entries exist
    const deliveryRelatedEntries = journal.filter(
      (e) =>
        typeof e.type === "string" &&
        (e.type.includes("delivery") ||
          e.type.includes("commit") ||
          e.type.includes("push") ||
          e.type.includes("pr_")),
    );
    expect(deliveryRelatedEntries).toHaveLength(0);
  });

  it("full monitoring-pilot cycle records complete evidence trail", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript
      .mockResolvedValueOnce(makeScriptOutput(makeHealthCheckEnvelope()))
      .mockResolvedValueOnce(makeScriptOutput(makeMetricsEnvelope()));
    mockResolveAgentBackend.mockReturnValue(createFullMonitoringBackend());

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify journal contains ordered lifecycle events with meaningful count
    const journal = readJournal(runsDir, task.id);
    const journalTypes = journal.map((e) => e.type);

    // Expect at minimum: subtask_queued, subtask_started, orchestrator_decision,
    // subtask_queued(script), subtask_started(script), script_started,
    // script_completed, subtask_completed(script) -- repeated for each phase
    expect(journal.length).toBeGreaterThanOrEqual(15);

    // Verify all subtask statuses are terminal
    const allSubtasks = task.subtasks ?? [];
    for (const subtask of allSubtasks) {
      expect(["completed", "failed"]).toContain(subtask.status);
    }

    // Verify subtask kinds include all expected dispatch types
    const subtaskKinds = allSubtasks.map((s) => s.kind);
    expect(subtaskKinds).toContain("orchestrator_eval");
    expect(subtaskKinds).toContain("script_run");
    expect(subtaskKinds).toContain("stage_agent_run");

    // Verify journal chronology is monotonically ordered
    const timestamps = journal
      .map((e) => e.timestamp as string)
      .filter(Boolean);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
    }
  });
});

// ---------------------------------------------------------------
// Group 4: No Bespoke Engine Logic Required
// ---------------------------------------------------------------

describe("No bespoke engine logic required", () => {
  it("monitoring-pilot uses same worker dispatch path as implementation recipes (no special cases)", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));
    mockResolveAgentBackend.mockReturnValue(
      createSingleScriptBackend("monitoring.check_health"),
    );

    await runTask(task, recipe, runsDir, registry);

    // Verify mockRunScript was called, confirming the standard dispatch path
    expect(mockRunScript).toHaveBeenCalledTimes(1);

    // Inspect the arguments passed to runScript to confirm standard structure
    const [command, , context] = mockRunScript.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];

    // Command should be derived from the manifest path resolved against workspacePath
    expect(command).toContain("check_health.sh");

    // Context should contain the standard fields (taskId, taskPayload)
    expect(context).toHaveProperty("taskId", task.id);
    expect(context).toHaveProperty("taskPayload");
  });

  it("monitoring scripts share registry infrastructure with all other scripts", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));
    mockResolveAgentBackend.mockReturnValue(
      createSingleScriptBackend("monitoring.check_health"),
    );

    await runTask(task, recipe, runsDir, registry);

    expect(mockRunScript).toHaveBeenCalledTimes(1);

    // Verify the command string contains the manifest-derived path,
    // proving the registry resolved the script (not a hardcoded path)
    const [command, , context] = mockRunScript.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(command).toContain("scripts/monitoring/check_health.sh");

    // Verify the context contains taskPayload with task state data,
    // confirming buildScriptStdinPayload ran through the standard code path
    expect(context).toHaveProperty("taskId", task.id);
    expect(context).toHaveProperty("taskPayload");
    const taskPayload = context.taskPayload as Record<string, unknown>;
    expect(taskPayload).toHaveProperty("task_state");
  });
});
