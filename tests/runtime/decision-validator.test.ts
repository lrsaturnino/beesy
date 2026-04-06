import { describe, it, expect } from "vitest";
import { validateDecision } from "../../src/runtime/decision-validator.js";
import type { ValidationResult } from "../../src/runtime/decision-validator.js";
import type {
  OrchestratorDecision,
  RecipeConfig,
  StageDefinition,
} from "../../src/recipes/types.js";
import type { ScriptManifest } from "../../src/scripts/types.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

/** Factory for a minimal StageDefinition with overridable fields. */
function createStageDefinition(
  overrides?: Partial<StageDefinition>,
): StageDefinition {
  return {
    role: "roles/planning.md",
    objective: "Produce a detailed plan",
    inputs: [
      { description: "Task description", source: "task.payload.description" },
    ],
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
        outputs: [{ label: "implementation_code", format: "ts" }],
        allowed_transitions: ["implement", "planning"],
      }),
    },
    ...overrides,
  };
}

/** Factory for a minimal valid OrchestratorDecision with overridable fields. */
function createTestDecision(
  overrides?: Partial<OrchestratorDecision>,
): OrchestratorDecision {
  return {
    action: "run_stage_agent",
    target_stage: "implement",
    reason: "Planning is complete, move to implementation",
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Group 1: Valid Decisions Pass Validation
// -------------------------------------------------------------------

describe("Valid Decisions Pass Validation", () => {
  it("accepts run_stage_agent with target in allowed_transitions", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "implement" });

    const result: ValidationResult = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.decision).toBe(decision);
    }
  });

  it("accepts retry (target equals current stage) within limit", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "planning" });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      { planning: 1 },
      0,
    );

    expect(result.valid).toBe(true);
  });

  it("accepts pause_for_input action", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      action: "pause_for_input",
      target_stage: undefined,
    });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(true);
  });

  it("accepts finish_run with all outputs produced", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      action: "finish_run",
      target_stage: undefined,
    });
    const completedOutputLabels = new Set(["planning_doc"]);

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      completedOutputLabels,
    );

    expect(result.valid).toBe(true);
  });

  it("accepts fail_run action", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      action: "fail_run",
      target_stage: undefined,
    });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 2: Transition Validation
// -------------------------------------------------------------------

describe("Transition Validation", () => {
  it("rejects target_stage not in allowed_transitions", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "deploy" });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("deploy");
    }
  });

  it("rejects target_stage that does not exist in recipe", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      target_stage: "nonexistent_stage",
    });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("nonexistent_stage");
    }
  });
});

// -------------------------------------------------------------------
// Group 3: Retry Budget Validation
// -------------------------------------------------------------------

describe("Retry Budget Validation", () => {
  it("rejects when retry count equals max_stage_retries (boundary)", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "planning" });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      { planning: 3 },
      0,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("3");
    }
  });

  it("rejects when retry count exceeds max_stage_retries", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "planning" });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      { planning: 5 },
      0,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("5");
    }
  });

  it("accepts retry at count just below limit", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "planning" });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      { planning: 2 },
      0,
    );

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 4: Total Action Budget Validation
// -------------------------------------------------------------------

describe("Total Action Budget Validation", () => {
  it("rejects when totalActionCount equals max_total_actions (boundary)", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "implement" });

    const result = validateDecision(decision, recipe, "planning", {}, 50);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("50");
    }
  });

  it("rejects when totalActionCount exceeds max_total_actions", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "implement" });

    const result = validateDecision(decision, recipe, "planning", {}, 60);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("60");
    }
  });

  it("accepts when totalActionCount is just below max_total_actions", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "implement" });

    const result = validateDecision(decision, recipe, "planning", {}, 49);

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 5: finish_run Output Completeness
// -------------------------------------------------------------------

describe("finish_run Output Completeness", () => {
  it("rejects finish_run when required outputs are missing", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      action: "finish_run",
      target_stage: undefined,
    });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("planning_doc");
    }
  });

  it("rejects finish_run with partial outputs produced", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          outputs: [
            { label: "planning_doc", format: "md" },
            { label: "findings", format: "json" },
          ],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const decision = createTestDecision({
      action: "finish_run",
      target_stage: undefined,
    });
    const completedOutputLabels = new Set(["planning_doc"]);

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      completedOutputLabels,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("findings");
    }
  });

  it("accepts finish_run when stage has no declared outputs", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({ outputs: [] }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const decision = createTestDecision({
      action: "finish_run",
      target_stage: undefined,
    });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 6: run_stage_agent Without target_stage
// -------------------------------------------------------------------

describe("run_stage_agent Without target_stage", () => {
  it("rejects run_stage_agent when target_stage is undefined", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: undefined });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("target_stage");
    }
  });

  it("rejects run_stage_agent when target_stage is empty string", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "" });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("target_stage");
    }
  });
});

// -------------------------------------------------------------------
// Group 7: Multiple Violations Collected
// -------------------------------------------------------------------

describe("Multiple Violations Collected", () => {
  it("collects all violations when multiple rules fail simultaneously", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "deploy" });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      { deploy: 3 },
      50,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Transition violation present
      expect(result.reason).toContain("deploy");
      // Total action budget violation present
      expect(result.reason).toContain("50");
    }
  });

  it("produces descriptive violation reasons with specific values", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "deploy" });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("deploy");
      // Reason should reference at least one of the allowed transitions
      const mentionsAllowed =
        result.reason.includes("planning") ||
        result.reason.includes("implement");
      expect(mentionsAllowed).toBe(true);
    }
  });
});

// -------------------------------------------------------------------
// Group 8: Return Type Structure
// -------------------------------------------------------------------

describe("Return Type Structure", () => {
  it("valid result contains the original decision object by reference", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "implement" });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.decision).toBe(decision);
    }
  });

  it("invalid result has valid === false and a non-empty reason string", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({ target_stage: "deploy" });

    const result = validateDecision(decision, recipe, "planning", {}, 0);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------------------
// Registry fixture helper
// -------------------------------------------------------------------

/**
 * Build a test script registry with entries for validating run_script
 * decisions. Uses env var names that will not exist in the test
 * environment to trigger env validation failures deterministically.
 */
function createTestRegistry(): Map<string, ScriptManifest> {
  const registry = new Map<string, ScriptManifest>();

  registry.set("knowledge.prime", {
    script_id: "knowledge.prime",
    description: "Prime knowledge base",
    runtime: "node",
    path: "scripts/knowledge-prime.ts",
    timeout_ms: 30000,
    retryable: true,
    side_effects: "read-only",
    required_env: ["BEES_TEST_MISSING_VAR_XYZ"],
    rerun_policy: "restart",
  });

  registry.set("repo.search", {
    script_id: "repo.search",
    description: "Search repository files",
    runtime: "node",
    path: "scripts/repo-search.ts",
    timeout_ms: 15000,
    retryable: false,
    side_effects: "read-only",
    required_env: [],
    rerun_policy: "restart",
  });

  return registry;
}

// -------------------------------------------------------------------
// Group 9: run_script Script ID Presence
// -------------------------------------------------------------------

describe("run_script Script ID Presence", () => {
  it("rejects run_script when script_id is undefined", () => {
    const recipe = createTestRecipe();
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: undefined,
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("run_script requires a script_id");
    }
  });

  it("rejects run_script when script_id is empty string", () => {
    const recipe = createTestRecipe();
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("run_script requires a script_id");
    }
  });

  it("does not apply script_id check to run_stage_agent", () => {
    const recipe = createTestRecipe();
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_stage_agent",
      target_stage: "implement",
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 10: run_script Registry and Allowlist Validation
// -------------------------------------------------------------------

describe("run_script Registry and Allowlist Validation", () => {
  it("accepts run_script with valid script_id in stage allowlist", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["knowledge.prime", "repo.search"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "repo.search",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(true);
  });

  it("rejects run_script with script_id not found in registry", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["nonexistent.script"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "nonexistent.script",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("nonexistent.script");
      expect(result.reason).toContain("not found in registry");
    }
  });

  it("rejects run_script with script_id not in stage allowed_scripts", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: [],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "knowledge.prime",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("knowledge.prime");
    }
  });

  it("accepts run_script when registry is not provided (backward compat)", () => {
    const recipe = createTestRecipe();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "anything",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
    );

    expect(result.valid).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 11: run_script Environment Requirements Validation
// -------------------------------------------------------------------

describe("run_script Environment Requirements Validation", () => {
  it("rejects run_script when required env vars are missing", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["knowledge.prime"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "knowledge.prime",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("BEES_TEST_MISSING_VAR_XYZ");
    }
  });

  it("accepts run_script when script has no required env vars", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["repo.search"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "repo.search",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(true);
  });

  it("lists all missing env var names in the violation", () => {
    const registry = new Map<string, ScriptManifest>();
    registry.set("multi.env", {
      script_id: "multi.env",
      description: "Script needing multiple env vars",
      runtime: "node",
      path: "scripts/multi-env.ts",
      timeout_ms: 10000,
      retryable: false,
      side_effects: "read-only",
      required_env: ["BEES_MISSING_A", "BEES_MISSING_B"],
      rerun_policy: "restart",
    });
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: ["multi.env"],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const decision = createTestDecision({
      action: "run_script",
      script_id: "multi.env",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("BEES_MISSING_A");
      expect(result.reason).toContain("BEES_MISSING_B");
    }
  });
});

// -------------------------------------------------------------------
// Group 12: run_script Combined Violations and Backward Compatibility
// -------------------------------------------------------------------

describe("run_script Combined Violations and Backward Compatibility", () => {
  it("collects script violations alongside other rule violations", () => {
    const recipe = createTestRecipe({
      stages: {
        planning: createStageDefinition({
          allowed_scripts: [],
        }),
        implement: createStageDefinition({
          role: "roles/implement.md",
          objective: "Implement the plan",
          outputs: [{ label: "implementation_code", format: "ts" }],
          allowed_transitions: ["implement", "planning"],
        }),
      },
    });
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_script",
      script_id: "nonexistent.script",
      target_stage: undefined,
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      50,
      undefined,
      registry,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Script violation present (not found in registry)
      expect(result.reason).toContain("nonexistent.script");
      // Total action budget violation present
      expect(result.reason).toContain("50");
    }
  });

  it("existing action types unaffected by registry parameter", () => {
    const recipe = createTestRecipe();
    const registry = createTestRegistry();
    const decision = createTestDecision({
      action: "run_stage_agent",
      target_stage: "implement",
    });

    const result = validateDecision(
      decision,
      recipe,
      "planning",
      {},
      0,
      undefined,
      registry,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.decision).toBe(decision);
    }
  });

  it("all existing test groups still pass (regression guard)", () => {
    // Verify existing action types work without registry parameter
    const recipe = createTestRecipe();

    // run_stage_agent still works
    const stageResult = validateDecision(
      createTestDecision({ target_stage: "implement" }),
      recipe,
      "planning",
      {},
      0,
    );
    expect(stageResult.valid).toBe(true);

    // pause_for_input still works
    const pauseResult = validateDecision(
      createTestDecision({ action: "pause_for_input", target_stage: undefined }),
      recipe,
      "planning",
      {},
      0,
    );
    expect(pauseResult.valid).toBe(true);

    // fail_run still works
    const failResult = validateDecision(
      createTestDecision({ action: "fail_run", target_stage: undefined }),
      recipe,
      "planning",
      {},
      0,
    );
    expect(failResult.valid).toBe(true);

    // finish_run with outputs still works
    const finishResult = validateDecision(
      createTestDecision({ action: "finish_run", target_stage: undefined }),
      recipe,
      "planning",
      {},
      0,
      new Set(["planning_doc"]),
    );
    expect(finishResult.valid).toBe(true);
  });
});
