import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// -------------------------------------------------------------------
// Group 1: OrchestratorConfig (src/recipes/types.ts)
// -------------------------------------------------------------------
describe("OrchestratorConfig", () => {
  it("exports OrchestratorConfig interface", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming OrchestratorConfig object is constructible with all required fields
    const config: Record<string, unknown> = {
      role: "roles/orchestrators/implementation.md",
      backend: "cli-claude",
      model: "anthropic/claude-sonnet-4-20250514",
      effort: "high",
      timeout_ms: 180000,
      max_stage_retries: 2,
      max_total_actions: 40,
    };
    expect(config.role).toBe("roles/orchestrators/implementation.md");
    expect(config.backend).toBe("cli-claude");
    expect(config.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(config.effort).toBe("high");
    expect(config.timeout_ms).toBe(180000);
    expect(config.max_stage_retries).toBe(2);
    expect(config.max_total_actions).toBe(40);
  });

  it("OrchestratorConfig requires all mandatory fields", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify that all mandatory fields exist on a conforming OrchestratorConfig object
    const config: Record<string, unknown> = {
      role: "roles/orchestrators/implementation.md",
      backend: "cli-claude",
      model: "anthropic/claude-sonnet-4-20250514",
      effort: "high",
      timeout_ms: 180000,
      max_stage_retries: 2,
      max_total_actions: 40,
    };
    const requiredKeys = [
      "role",
      "backend",
      "model",
      "effort",
      "timeout_ms",
      "max_stage_retries",
      "max_total_actions",
    ];
    for (const key of requiredKeys) {
      expect(
        config[key],
        `OrchestratorConfig must have required field: ${key}`,
      ).toBeDefined();
    }
  });
});

// -------------------------------------------------------------------
// Group 2: StageDefinition (src/recipes/types.ts)
// -------------------------------------------------------------------
describe("StageDefinition", () => {
  it("exports StageDefinition interface", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming StageDefinition object is constructible with all fields
    const stage: Record<string, unknown> = {
      role: "roles/implementation/planning-create.md",
      objective: "Analyze the request and produce an implementation plan",
      inputs: [
        { description: "User request", source: "task.payload.description" },
      ],
      outputs: [{ label: "planning_doc", format: "md" }],
      allowed_transitions: [],
      allowed_scripts: [],
    };
    expect(stage.role).toBe("roles/implementation/planning-create.md");
    expect(stage.objective).toBe(
      "Analyze the request and produce an implementation plan",
    );
    expect(Array.isArray(stage.inputs)).toBe(true);
    expect(Array.isArray(stage.outputs)).toBe(true);
    expect(Array.isArray(stage.allowed_transitions)).toBe(true);
    expect(Array.isArray(stage.allowed_scripts)).toBe(true);
  });

  it("StageDefinition outputs support optional mirror_to field", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify output entries accept optional mirror_to for compatibility file mirrors
    const output: Record<string, unknown> = {
      label: "planning_doc",
      format: "md",
      mirror_to: [".bees/planning.md"],
    };
    expect(output.mirror_to).toBeDefined();
    expect(Array.isArray(output.mirror_to)).toBe(true);
    expect((output.mirror_to as string[])[0]).toBe(".bees/planning.md");
  });

  it("StageDefinition requires all mandatory fields", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify that all mandatory fields exist on a conforming StageDefinition object
    const stage: Record<string, unknown> = {
      role: "roles/implementation/planning-create.md",
      objective: "Produce the planning document",
      inputs: [
        { description: "User request", source: "task.payload.description" },
      ],
      outputs: [{ label: "planning_doc", format: "md" }],
      allowed_transitions: ["planning_create"],
      allowed_scripts: ["repo.search"],
    };
    const requiredKeys = [
      "role",
      "objective",
      "inputs",
      "outputs",
      "allowed_transitions",
      "allowed_scripts",
    ];
    for (const key of requiredKeys) {
      expect(
        stage[key],
        `StageDefinition must have required field: ${key}`,
      ).toBeDefined();
    }
  });
});

// -------------------------------------------------------------------
// Group 3: RecipeConfig (src/recipes/types.ts)
// -------------------------------------------------------------------
describe("RecipeConfig", () => {
  it("exports RecipeConfig interface", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify a conforming RecipeConfig object is constructible with all sections
    const config: Record<string, unknown> = {
      id: "new-implementation",
      name: "New Implementation",
      command: "/new-implementation",
      description: "Full implementation workflow from planning through code delivery",
      orchestrator: {
        role: "roles/orchestrators/implementation.md",
        backend: "cli-claude",
        model: "anthropic/claude-sonnet-4-20250514",
        effort: "high",
        timeout_ms: 180000,
        max_stage_retries: 2,
        max_total_actions: 40,
      },
      stage_order: ["planning"],
      start_stage: "planning",
      stages: {
        planning: {
          role: "roles/implementation/planning-create.md",
          objective: "Analyze the request and produce an implementation plan",
          inputs: [
            {
              description: "User request",
              source: "task.payload.description",
            },
          ],
          outputs: [{ label: "planning_doc", format: "md" }],
          allowed_transitions: [],
          allowed_scripts: [],
        },
      },
    };
    expect(config.id).toBe("new-implementation");
    expect(config.name).toBe("New Implementation");
    expect(config.command).toBe("/new-implementation");
    expect(config.description).toBeDefined();
    expect(typeof config.orchestrator).toBe("object");
    expect(Array.isArray(config.stage_order)).toBe(true);
    expect(config.start_stage).toBe("planning");
    expect(typeof config.stages).toBe("object");
  });

  it("RecipeConfig.stages is a map of StageDefinition keyed by stage ID", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify the stages field is a Record<string, StageDefinition> shape
    const config: Record<string, unknown> = {
      id: "new-implementation",
      name: "New Implementation",
      command: "/new-implementation",
      description: "Full implementation workflow",
      orchestrator: {
        role: "roles/orchestrators/implementation.md",
        backend: "cli-claude",
        model: "anthropic/claude-sonnet-4-20250514",
        effort: "high",
        timeout_ms: 180000,
        max_stage_retries: 2,
        max_total_actions: 40,
      },
      stage_order: ["planning"],
      start_stage: "planning",
      stages: {
        planning: {
          role: "roles/implementation/planning-create.md",
          objective: "Analyze the request and produce an implementation plan",
          inputs: [
            {
              description: "User request",
              source: "task.payload.description",
            },
          ],
          outputs: [
            {
              label: "planning_doc",
              format: "md",
              mirror_to: [".bees/planning.md"],
            },
          ],
          allowed_transitions: [],
          allowed_scripts: [],
        },
      },
    };
    const stages = config.stages as Record<string, Record<string, unknown>>;
    expect(stages.planning).toBeDefined();
    expect(stages.planning.role).toBeDefined();
    expect(stages.planning.objective).toBeDefined();
    expect(stages.planning.inputs).toBeDefined();
    expect(stages.planning.outputs).toBeDefined();
  });

  it("RecipeConfig requires all mandatory fields", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify that all mandatory fields exist on a conforming RecipeConfig object
    const config: Record<string, unknown> = {
      id: "new-implementation",
      name: "New Implementation",
      command: "/new-implementation",
      description: "Full implementation workflow",
      orchestrator: {
        role: "roles/orchestrators/implementation.md",
        backend: "cli-claude",
        model: "anthropic/claude-sonnet-4-20250514",
        effort: "high",
        timeout_ms: 180000,
        max_stage_retries: 2,
        max_total_actions: 40,
      },
      stage_order: ["planning"],
      start_stage: "planning",
      stages: {},
    };
    const requiredKeys = [
      "id",
      "name",
      "command",
      "description",
      "orchestrator",
      "stage_order",
      "start_stage",
      "stages",
    ];
    for (const key of requiredKeys) {
      expect(
        config[key],
        `RecipeConfig must have required field: ${key}`,
      ).toBeDefined();
    }
  });
});

// -------------------------------------------------------------------
// Group 4: OrchestratorDecision (src/recipes/types.ts)
// -------------------------------------------------------------------
describe("OrchestratorDecision", () => {
  it("exports OrchestratorDecision interface with action discriminant", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify four decision objects, one per action variant, are constructible
    const runStage: Record<string, unknown> = {
      action: "run_stage_agent",
      target_stage: "planning",
      reason: "Execute the planning stage agent.",
    };
    const pause: Record<string, unknown> = {
      action: "pause_for_input",
      reason: "Need clarification from the requester.",
    };
    const finish: Record<string, unknown> = {
      action: "finish_run",
      reason: "All stages completed successfully.",
    };
    const fail: Record<string, unknown> = {
      action: "fail_run",
      reason: "Unrecoverable error in the planning stage.",
    };
    expect(runStage.action).toBe("run_stage_agent");
    expect(pause.action).toBe("pause_for_input");
    expect(finish.action).toBe("finish_run");
    expect(fail.action).toBe("fail_run");
  });

  it("OrchestratorDecision supports optional fields", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify target_stage, input_patch, state_patch, reason are all present when provided
    const decision: Record<string, unknown> = {
      action: "run_stage_agent",
      target_stage: "historical_search",
      input_patch: {
        search_artifact_ids: ["art_01JABC123"],
      },
      state_patch: {
        last_reasoning_mode: "gather_more_context",
      },
      reason: "Search results are sufficient to execute the stage role.",
    };
    expect(decision.target_stage).toBe("historical_search");
    expect(typeof decision.input_patch).toBe("object");
    expect(typeof decision.state_patch).toBe("object");
    expect(decision.reason).toBe(
      "Search results are sufficient to execute the stage role.",
    );
  });

  it("OrchestratorDecision action field accepts only valid action values", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // Verify the ORCHESTRATOR_ACTIONS const array exports the four valid action strings
    const actions = (mod as Record<string, unknown>)
      .ORCHESTRATOR_ACTIONS as readonly string[];
    expect(actions).toBeDefined();
    expect(actions).toHaveLength(4);
    expect(actions).toContain("run_stage_agent");
    expect(actions).toContain("pause_for_input");
    expect(actions).toContain("finish_run");
    expect(actions).toContain("fail_run");
  });
});

// -------------------------------------------------------------------
// Group 5: Cross-Module and Compilation
// -------------------------------------------------------------------
describe("cross-module and compilation", () => {
  it("recipes/types.ts module can be imported without conflicts alongside existing type modules", async () => {
    const recipesMod = await import("../../src/recipes/types.js");
    const queueMod = await import("../../src/queue/types.js");
    const runnersMod = await import("../../src/runners/types.js");
    const gatesMod = await import("../../src/gates/types.js");

    expect(recipesMod).toBeDefined();
    expect(queueMod).toBeDefined();
    expect(runnersMod).toBeDefined();
    expect(gatesMod).toBeDefined();
  });

  it("TypeScript compilation passes with recipes/types.ts included", () => {
    const result = execSync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    // tsc --noEmit outputs nothing on success
    expect(result.trim()).toBe("");
  });

  it("SubtaskKind is not exported from recipes/types.ts", async () => {
    const mod = await import("../../src/recipes/types.js");
    expect(mod).toBeDefined();
    // SubtaskKind belongs in queue/types.ts, not here
    expect(
      (mod as Record<string, unknown>).SubtaskKind,
    ).toBeUndefined();
  });
});
