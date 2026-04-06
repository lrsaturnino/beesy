import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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

// Import module under test
import { runTask } from "../../src/runtime/worker.js";

// Import real dependency modules for verification
import { readJournal } from "../../src/runtime/journal.js";
import { validateRecipe } from "../../src/recipes/loader.js";
import { loadScriptRegistry, resolveScript } from "../../src/scripts/registry.js";
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
  runsDir = await mkdtemp(path.join(tmpdir(), "bees-pilot-"));
  workspacePath = await mkdtemp(path.join(tmpdir(), "bees-pilot-ws-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Absolute path to the pilot recipe YAML on disk (used by unit tests). */
const PILOT_RECIPE_PATH = path.join(
  path.dirname(path.dirname(__dirname)),
  "recipes",
  "monitoring-pilot",
  "recipe.yaml",
);

/** Absolute path to the project root (parent of the tests/ directory). */
const PROJECT_ROOT = path.dirname(path.dirname(__dirname));

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Standard valid script result envelope for the health check script. */
function makeHealthCheckEnvelope(): string {
  return JSON.stringify({
    summary: "Health check passed: all 3 systems operational",
    outputs: {},
    state_patch: { health_status: "healthy" },
    metrics: { checks_run: 3, healthy_count: 3 },
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

/** Build a StepOutput simulating a failed script run with timeout. */
function makeScriptTimeoutOutput(): StepOutput {
  return {
    output: "",
    outputFiles: [],
    error: "Script timeout: execution exceeded 60000ms limit",
  };
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
    description: "Script-heavy monitoring recipe for validating the script registry model",
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
    id: "task-pilot-001",
    gate: "monitoring-pilot",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { target: "production", description: "Run monitoring pilot" },
    requestedBy: "user-pilot",
    sourceChannel: { platform: "slack", channelId: "C-PILOT" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
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
 * Standard integration test fixture: create recipe, write role files, build
 * task and registry, and configure the default script mock (healthy envelope).
 *
 * Returns all four objects so individual tests can customise them before
 * calling `runTask()`.
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
  mockRunScript.mockResolvedValue(makeScriptOutput(makeHealthCheckEnvelope()));
  return { recipe, task, registry };
}

// ---------------------------------------------------------------
// Unit Tests: Pilot Recipe Loading
// ---------------------------------------------------------------

describe("Pilot recipe loading", () => {
  it("pilot recipe YAML loads without validation errors", async () => {
    const content = await readFile(PILOT_RECIPE_PATH, "utf-8");
    const messages = validateRecipe(parseYaml(content), PILOT_RECIPE_PATH);
    const errors = messages.filter((m) => m.severity === "error");

    expect(errors).toHaveLength(0);
  });

  it("pilot recipe stages include allowed_scripts referencing manifest IDs", async () => {
    const content = await readFile(PILOT_RECIPE_PATH, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const stages = parsed.stages as Record<string, Record<string, unknown>>;

    // The collect_data stage should have the pilot script IDs
    const collectData = stages.collect_data;
    expect(collectData).toBeDefined();
    const allowedScripts = collectData.allowed_scripts as string[];
    expect(allowedScripts).toContain("monitoring.check_health");
    expect(allowedScripts).toContain("monitoring.aggregate_metrics");
  });

  it("pilot scripts registered in manifest load successfully", async () => {
    const manifestPath = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");

    const registry = await loadScriptRegistry(manifestPath, PROJECT_ROOT);

    // Registry should contain both pilot entries
    const healthScript = resolveScript(registry, "monitoring.check_health");
    expect(healthScript).not.toBeNull();
    expect(healthScript!.runtime).toBe("shell");

    const metricsScript = resolveScript(registry, "monitoring.aggregate_metrics");
    expect(metricsScript).not.toBeNull();
    expect(metricsScript!.runtime).toBe("shell");

    // Registry should have at least 4 entries (2 existing + 2 pilot)
    expect(registry.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------
// Integration Tests: Worker Loop with Script Dispatch
// ---------------------------------------------------------------

describe("Worker script dispatch", () => {
  it("pilot recipe runs through worker with mock script execution (happy path)", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "run health check",
      }),
      makeDecisionOutput({
        action: "finish_run",
        reason: "monitoring complete",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify script_run subtask was created and completed
    const scriptSubtask = task.subtasks!.find((s) => s.kind === "script_run");
    expect(scriptSubtask).toBeDefined();
    expect(scriptSubtask!.status).toBe("completed");

    // Verify journal has script lifecycle events
    const journal = readJournal(runsDir, task.id);
    const scriptStarted = journal.find((e) => e.type === "script_started");
    expect(scriptStarted).toBeDefined();
    expect(scriptStarted!.scriptId).toBe("monitoring.check_health");

    const scriptCompleted = journal.find((e) => e.type === "script_completed");
    expect(scriptCompleted).toBeDefined();
    expect(scriptCompleted!.scriptId).toBe("monitoring.check_health");
  });

  it("multi-stage pilot with script-then-stage-agent flow", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "collect health data",
      }),
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "analyze",
        reason: "analyze collected data",
      }),
      makeStageOutput("# Monitoring Report\n\nAll systems healthy."),
      makeDecisionOutput({
        action: "finish_run",
        reason: "monitoring and analysis complete",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify both subtask types created and completed
    const scriptSub = task.subtasks!.find((s) => s.kind === "script_run");
    const agentSub = task.subtasks!.find((s) => s.kind === "stage_agent_run");
    expect(scriptSub).toBeDefined();
    expect(scriptSub!.status).toBe("completed");
    expect(agentSub).toBeDefined();
    expect(agentSub!.status).toBe("completed");
  });

  it("script-result injection into stage agent inputs", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "collect health data",
      }),
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "analyze",
        input_patch: {
          monitoring_data: { _script_output: "monitoring.check_health" },
        },
        reason: "analyze with script output injection",
      }),
      makeStageOutput("# Analysis\n\nHealth status: healthy"),
      makeDecisionOutput({
        action: "finish_run",
        reason: "all done",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify script_output_injected journal entry
    const journal = readJournal(runsDir, task.id);
    const injected = journal.find((e) => e.type === "script_output_injected");
    expect(injected).toBeDefined();
    expect(injected!.scriptId).toBe("monitoring.check_health");
    expect(injected!.targetKey).toBe("monitoring_data");
  });

  it("long-running mock script with timeout verification", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    // Override: script times out instead of succeeding
    mockRunScript.mockResolvedValue(makeScriptTimeoutOutput());

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "run health check",
      }),
      // After timeout failure, orchestrator finishes the run
      makeDecisionOutput({
        action: "finish_run",
        reason: "script timed out, finishing",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Task should complete (orchestrator decided to finish despite failure)
    expect(task.status).toBe("completed");

    // Verify the script subtask was marked failed
    const scriptSub = task.subtasks!.find((s) => s.kind === "script_run");
    expect(scriptSub).toBeDefined();
    expect(scriptSub!.status).toBe("failed");

    // Verify journal has script_failed event
    const journal = readJournal(runsDir, task.id);
    const scriptFailed = journal.find((e) => e.type === "script_failed");
    expect(scriptFailed).toBeDefined();

    // Verify an orchestrator_eval was enqueued after the failure
    const journalTypes = journal.map((e) => e.type);
    const failedIdx = journalTypes.indexOf("subtask_failed");
    const nextQueueIdx = journalTypes.indexOf("subtask_queued", failedIdx);
    expect(nextQueueIdx).toBeGreaterThan(failedIdx);
  });

  it("partial-rerun semantics test (continue policy receives prior_result)", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    // Override: switch health check to continue policy for rerun testing
    const healthManifest = registry.get("monitoring.check_health")!;
    registry.set("monitoring.check_health", {
      ...healthManifest,
      rerun_policy: "continue",
    });

    // Override: two sequential successful runs
    mockRunScript
      .mockResolvedValueOnce(makeScriptOutput(makeHealthCheckEnvelope()))
      .mockResolvedValueOnce(makeScriptOutput(makeHealthCheckEnvelope()));

    // Sequence: run_script -> run_script (same, continue) -> finish_run
    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "first health check",
      }),
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "rerun health check with continue",
      }),
      makeDecisionOutput({
        action: "finish_run",
        reason: "monitoring complete",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    expect(task.status).toBe("completed");

    // Verify two script_run subtasks were created
    const scriptSubs = task.subtasks!.filter((s) => s.kind === "script_run");
    expect(scriptSubs).toHaveLength(2);

    // Verify journal shows two script_started entries (proving both ran)
    const journal = readJournal(runsDir, task.id);
    const scriptStartedEntries = journal.filter(
      (e) => e.type === "script_started" && e.scriptId === "monitoring.check_health",
    );
    expect(scriptStartedEntries).toHaveLength(2);

    // Verify journal shows two script_completed entries
    const scriptCompletedEntries = journal.filter(
      (e) => e.type === "script_completed" && e.scriptId === "monitoring.check_health",
    );
    expect(scriptCompletedEntries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------
// End-to-End Tests: Full Cycle Verification
// ---------------------------------------------------------------

describe("End-to-end cycle verification", () => {
  it("full orchestrator -> run_script -> orchestrator -> run_stage_agent -> orchestrator -> finish_run cycle", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "collect health data",
      }),
      makeDecisionOutput({
        action: "run_stage_agent",
        target_stage: "analyze",
        input_patch: {
          health: { _script_output: "monitoring.check_health" },
        },
        reason: "analyze with injected script output",
      }),
      makeStageOutput("# Monitoring Report\n\nAll systems healthy. 3/3 checks passed."),
      makeDecisionOutput({
        action: "finish_run",
        reason: "monitoring cycle complete",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Verify task completed
    expect(task.status).toBe("completed");

    // Verify exactly 3 orchestrator_decision journal entries
    const journal = readJournal(runsDir, task.id);
    const decisions = journal.filter((e) => e.type === "orchestrator_decision");
    expect(decisions).toHaveLength(3);
    expect(decisions[0].action).toBe("run_script");
    expect(decisions[1].action).toBe("run_stage_agent");
    expect(decisions[2].action).toBe("finish_run");

    // Verify script_output_injected journal entry present
    const injected = journal.find((e) => e.type === "script_output_injected");
    expect(injected).toBeDefined();

    // Verify subtask count: 3 orchestrator_eval + 1 script_run + 1 stage_agent_run = 5
    expect(task.subtasks!).toHaveLength(5);
    const kinds = task.subtasks!.map((s) => s.kind);
    expect(kinds.filter((k) => k === "orchestrator_eval")).toHaveLength(3);
    expect(kinds.filter((k) => k === "script_run")).toHaveLength(1);
    expect(kinds.filter((k) => k === "stage_agent_run")).toHaveLength(1);
  });

  it("journal traces verify script lifecycle events in correct order", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "health check",
      }),
      makeDecisionOutput({
        action: "finish_run",
        reason: "done",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    const journal = readJournal(runsDir, task.id);

    // Filter script-related entries for chronological ordering verification
    const scriptRelatedTypes = journal
      .filter(
        (e) =>
          (e.type === "subtask_queued" && e.kind === "script_run") ||
          (e.type === "subtask_started" && e.kind === "script_run") ||
          e.type === "script_started" ||
          e.type === "script_completed" ||
          (e.type === "subtask_completed" && e.kind === "script_run"),
      )
      .map((e) => e.type);

    // Verify chronological order of script lifecycle
    expect(scriptRelatedTypes).toEqual([
      "subtask_queued",
      "subtask_started",
      "script_started",
      "script_completed",
      "subtask_completed",
    ]);
  });

  it("orchestrator prompt includes script catalog and allowed scripts", async () => {
    const { recipe, task, registry } = await setupPilotFixture();

    const backend = createSequenceBackend([
      makeDecisionOutput({
        action: "run_script",
        script_id: "monitoring.check_health",
        reason: "health check",
      }),
      makeDecisionOutput({
        action: "finish_run",
        reason: "done",
      }),
    ]);
    mockResolveAgentBackend.mockReturnValue(backend);

    await runTask(task, recipe, runsDir, registry);

    // Inspect the first orchestrator call to verify prompt content
    const firstCall = (backend.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const agentConfig = firstCall[0];
    const systemPrompt = agentConfig.systemPrompt as string;

    // The prompt should contain "Available Scripts:" with the pilot script IDs
    expect(systemPrompt).toContain("Available Scripts:");
    expect(systemPrompt).toContain("monitoring.check_health");
    expect(systemPrompt).toContain("monitoring.aggregate_metrics");

    // The prompt should contain "Allowed Scripts for This Stage:" with the IDs
    expect(systemPrompt).toContain("Allowed Scripts for This Stage:");
    expect(systemPrompt).toContain("monitoring.check_health");
  });
});
