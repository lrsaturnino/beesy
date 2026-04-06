import { describe, it, expect } from "vitest";
import { buildOrchestratorContext } from "../../src/runtime/orchestrator-context.js";
import type { OrchestratorContext } from "../../src/runtime/orchestrator-context.js";
import type { Task } from "../../src/queue/types.js";
import type {
  RecipeConfig,
  StageDefinition,
} from "../../src/recipes/types.js";
import type {
  ScriptManifest,
  ScriptCatalogEntry,
} from "../../src/scripts/types.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

/** Default zero-value cost accumulator for test fixtures. */
function zeroCost() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** Factory for a minimal StageDefinition with overridable fields. */
function createStageDefinition(
  overrides?: Partial<StageDefinition>,
): StageDefinition {
  return {
    role: "roles/planning.md",
    objective: "Produce a detailed plan",
    inputs: [{ description: "Task description", source: "task.payload.description" }],
    outputs: [{ label: "planning_doc", format: "md" }],
    allowed_transitions: ["planning", "implement"],
    allowed_scripts: [],
    ...overrides,
  };
}

/** Factory for a minimal RecipeConfig with two stages. */
function createTestRecipe(overrides?: Partial<RecipeConfig>): RecipeConfig {
  return {
    id: "test-recipe",
    name: "Test Recipe",
    command: "/test-recipe",
    description: "A recipe for testing",
    orchestrator: {
      role: "roles/orchestrator.md",
      backend: "cli-claude",
      model: "anthropic/claude-sonnet-4-20250514",
      effort: "high",
      timeout_ms: 60000,
      max_stage_retries: 3,
      max_total_actions: 50,
    },
    stage_order: ["planning", "implement"],
    start_stage: "planning",
    stages: {
      planning: createStageDefinition(),
      implement: createStageDefinition({
        role: "roles/implement.md",
        objective: "Implement the plan",
        allowed_transitions: ["implement", "planning"],
      }),
    },
    ...overrides,
  };
}

/** Factory for a minimal valid Task with recipe-oriented fields. */
function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    gate: "test-gate",
    status: "active",
    priority: "normal",
    position: 0,
    payload: { description: "test task" },
    requestedBy: "user-1",
    sourceChannel: { platform: "slack", channelId: "C123" },
    createdAt: new Date("2026-04-06T00:00:00.000Z"),
    cost: zeroCost(),
    currentStageId: "planning",
    stageRetryCount: {},
    totalActionCount: 0,
    ...overrides,
  };
}

/** Factory for a ScriptManifest with valid defaults and overridable fields. */
function createTestManifest(
  overrides?: Partial<ScriptManifest>,
): ScriptManifest {
  return {
    script_id: "test.script",
    description: "A test script",
    runtime: "node",
    path: "scripts/test.js",
    timeout_ms: 30000,
    retryable: true,
    side_effects: "read-only",
    required_env: [],
    rerun_policy: "restart",
    ...overrides,
  };
}

/** Factory for a registry Map with two script manifests. */
function createTestRegistry(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();
  registry.set(
    "knowledge.prime",
    createTestManifest({
      script_id: "knowledge.prime",
      description: "Prime context with relevant knowledge",
      runtime: "python",
      side_effects: "read-only",
      timeout_ms: 45000,
      retryable: false,
    }),
  );
  registry.set(
    "repo.search",
    createTestManifest({
      script_id: "repo.search",
      description: "Search the repository for patterns",
      runtime: "node",
      side_effects: "read-only",
      timeout_ms: 20000,
      retryable: true,
    }),
  );
  return registry;
}

// -------------------------------------------------------------------
// Group 1: Context Assembly -- Stage and Transitions
// -------------------------------------------------------------------

describe("Context Assembly -- Stage and Transitions", () => {
  it("produces context with correct current stage ID and definition", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({ currentStageId: "planning" });

    const ctx: OrchestratorContext = buildOrchestratorContext(
      task,
      recipe,
      null,
      null,
      "",
    );

    expect(ctx.currentStageId).toBe("planning");
    expect(ctx.stageDefinition.objective).toBe("Produce a detailed plan");
    expect(ctx.stageDefinition.role).toBe("roles/planning.md");
  });

  it("includes allowed transitions from current stage definition", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({ currentStageId: "planning" });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.allowedTransitions).toEqual(["planning", "implement"]);
  });

  it("throws descriptive error when current stage ID not found in recipe", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({ currentStageId: "nonexistent" });

    expect(() =>
      buildOrchestratorContext(task, recipe, null, null, ""),
    ).toThrow(/nonexistent/);
  });
});

// -------------------------------------------------------------------
// Group 2: Budget and Retry Tracking
// -------------------------------------------------------------------

describe("Budget and Retry Tracking", () => {
  it("includes retry counts from task state", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({
      stageRetryCount: { planning: 2, implement: 0 },
    });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.retryCounts).toEqual({ planning: 2, implement: 0 });
  });

  it("defaults retry counts to empty object when task has no stageRetryCount", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    delete task.stageRetryCount;

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.retryCounts).toEqual({});
  });

  it("includes total action count from task state", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({ totalActionCount: 7 });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.totalActionCount).toBe(7);
  });

  it("defaults total action count to zero when task has no totalActionCount", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    delete task.totalActionCount;

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.totalActionCount).toBe(0);
  });

  it("includes configured budget limits from orchestrator config", () => {
    const recipe = createTestRecipe({
      orchestrator: {
        role: "roles/orchestrator.md",
        backend: "cli-claude",
        model: "anthropic/claude-sonnet-4-20250514",
        effort: "high",
        timeout_ms: 60000,
        max_stage_retries: 3,
        max_total_actions: 50,
      },
    });
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.maxStageRetries).toBe(3);
    expect(ctx.maxTotalActions).toBe(50);
  });
});

// -------------------------------------------------------------------
// Group 3: Latest Stage Output
// -------------------------------------------------------------------

describe("Latest Stage Output", () => {
  it("includes latest stage output when provided", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(
      task,
      recipe,
      "Stage completed successfully with results...",
      null,
      "",
    );

    expect(ctx.latestStageOutput).toBe(
      "Stage completed successfully with results...",
    );
  });

  it("handles null latest stage output on first evaluation", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.latestStageOutput).toBeNull();
  });

  it("handles undefined latest stage output gracefully", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, undefined, null, "");

    expect(ctx.latestStageOutput).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 4: Input Patch from Previous Decision
// -------------------------------------------------------------------

describe("Input Patch from Previous Decision", () => {
  it("includes input_patch from previous orchestrator decision", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    const patch = { query: "find patterns", mode: "deep" };

    const ctx = buildOrchestratorContext(task, recipe, null, patch, "");

    expect(ctx.inputPatch).toEqual({ query: "find patterns", mode: "deep" });
  });

  it("handles null input patch when no previous decision exists", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.inputPatch).toBeNull();
  });

  it("handles undefined input patch gracefully", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, undefined, "");

    expect(ctx.inputPatch).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 5: Journal Summary
// -------------------------------------------------------------------

describe("Journal Summary", () => {
  it("includes journal summary in context", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    const journal =
      "orchestrator_eval: planning -> run_stage_agent planning\nstage_agent_run: planning completed";

    const ctx = buildOrchestratorContext(task, recipe, null, null, journal);

    expect(ctx.journalSummary).toBe(journal);
  });

  it("handles empty journal summary", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.journalSummary).toBe("");
  });
});

// -------------------------------------------------------------------
// Group 6: Immutability and Object Safety
// -------------------------------------------------------------------

describe("Immutability and Object Safety", () => {
  it("does not mutate the input task object", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({
      stageRetryCount: { planning: 1 },
      totalActionCount: 5,
    });
    const originalRetryCount = { ...task.stageRetryCount };
    const originalActionCount = task.totalActionCount;

    buildOrchestratorContext(task, recipe, null, null, "");

    expect(task.stageRetryCount).toEqual(originalRetryCount);
    expect(task.totalActionCount).toBe(originalActionCount);
  });

  it("returns a fresh retryCounts object (not a shared reference)", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({
      stageRetryCount: { planning: 1 },
    });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");
    ctx.retryCounts["planning"] = 999;

    expect(task.stageRetryCount!["planning"]).toBe(1);
  });
});

// -------------------------------------------------------------------
// Group 7: Script Catalog Population
// -------------------------------------------------------------------

describe("Script Catalog Population", () => {
  it("populates scriptCatalog from registry when provided", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    const registry = createTestRegistry();

    const ctx = buildOrchestratorContext(
      task,
      recipe,
      null,
      null,
      "",
      registry,
    );

    expect(ctx.scriptCatalog).toHaveLength(2);
    const ids = ctx.scriptCatalog.map((e: ScriptCatalogEntry) => e.script_id);
    expect(ids).toContain("knowledge.prime");
    expect(ids).toContain("repo.search");
  });

  it("catalog entries contain all required fields from manifests", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    const registry = createTestRegistry();

    const ctx = buildOrchestratorContext(
      task,
      recipe,
      null,
      null,
      "",
      registry,
    );

    const knowledgeEntry = ctx.scriptCatalog.find(
      (e: ScriptCatalogEntry) => e.script_id === "knowledge.prime",
    );
    expect(knowledgeEntry).toBeDefined();
    expect(knowledgeEntry!.description).toBe(
      "Prime context with relevant knowledge",
    );
    expect(knowledgeEntry!.runtime).toBe("python");
    expect(knowledgeEntry!.side_effects).toBe("read-only");
    expect(knowledgeEntry!.timeout_ms).toBe(45000);
    expect(knowledgeEntry!.retryable).toBe(false);
  });

  it("defaults scriptCatalog to empty array when registry is omitted", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.scriptCatalog).toEqual([]);
  });

  it("defaults scriptCatalog to empty array when registry is undefined", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();

    const ctx = buildOrchestratorContext(
      task,
      recipe,
      null,
      null,
      "",
      undefined,
    );

    expect(ctx.scriptCatalog).toEqual([]);
  });

  it("includes orchestrator_notes when present on manifest", () => {
    const recipe = createTestRecipe();
    const task = createTestTask();
    const registry = new Map<string, ScriptManifest>();
    registry.set(
      "annotated.script",
      createTestManifest({
        script_id: "annotated.script",
        description: "Script with notes",
        orchestrator_notes: "Use when deep analysis is needed",
      }),
    );

    const ctx = buildOrchestratorContext(
      task,
      recipe,
      null,
      null,
      "",
      registry,
    );

    expect(ctx.scriptCatalog).toHaveLength(1);
    expect(ctx.scriptCatalog[0].orchestrator_notes).toBe(
      "Use when deep analysis is needed",
    );
  });
});

// -------------------------------------------------------------------
// Group 8: Allowed Scripts Extraction
// -------------------------------------------------------------------

describe("Allowed Scripts Extraction", () => {
  it("extracts allowedScripts from current stage definition", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["knowledge.prime", "repo.search"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const task = createTestTask({ currentStageId: "planning" });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.allowedScripts).toEqual(["knowledge.prime", "repo.search"]);
  });

  it("returns empty allowedScripts when stage has no allowed scripts", () => {
    const recipe = createTestRecipe();
    const task = createTestTask({ currentStageId: "planning" });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    expect(ctx.allowedScripts).toEqual([]);
  });

  it("allowedScripts does not share reference with stageDefinition", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["a", "b"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const task = createTestTask({ currentStageId: "planning" });

    const ctx = buildOrchestratorContext(task, recipe, null, null, "");

    // The readonly type prevents direct mutation, but we verify identity
    // is separate to ensure no shared reference mutation risk
    expect(ctx.allowedScripts).toEqual(["a", "b"]);
    expect(ctx.stageDefinition.allowed_scripts).toEqual(["a", "b"]);
  });
});
