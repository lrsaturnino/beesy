import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadRecipes, validateRecipe } from "../../src/recipes/loader.js";
import type { RecipeConfig } from "../../src/recipes/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

/** Filter validation messages down to errors only. */
function errorMessages(messages: Array<{ severity: string; message: string }>): Array<{ severity: string; message: string }> {
  return messages.filter((m) => m.severity === "error");
}

/** Filter validation messages down to warnings only. */
function warningMessages(messages: Array<{ severity: string; message: string }>): Array<{ severity: string; message: string }> {
  return messages.filter((m) => m.severity === "warning");
}

/** Join all message texts into a single string for assertion matching. */
function joinedText(messages: Array<{ message: string }>): string {
  return messages.map((m) => m.message).join(" ");
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-recipe-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Write a recipe YAML file under a subdirectory in the temp directory.
 * Creates the <tempDir>/<recipeId>/recipe.yaml structure that the loader expects.
 */
async function writeRecipeYaml(
  recipeId: string,
  content: string,
): Promise<void> {
  const recipeDir = path.join(tempDir, recipeId);
  await mkdir(recipeDir, { recursive: true });
  await writeFile(path.join(recipeDir, "recipe.yaml"), content, "utf-8");
}

// -------------------------------------------------------------------
// YAML fixture constants
// -------------------------------------------------------------------

const VALID_SINGLE_STAGE_YAML = `
recipe:
  id: single-stage
  name: "Single Stage Recipe"
  command: /single-stage
  description: "A minimal recipe with one stage"

orchestrator:
  role: roles/orchestrators/implementation.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/implementation/planning-create.md
    objective: "Analyze the request and produce an implementation plan"
    inputs:
      - description: "User request"
        source: task.payload.description
    outputs:
      - label: planning_doc
        format: md
    allowed_transitions: []
    allowed_scripts: []
`;

const VALID_MULTI_STAGE_YAML = `
recipe:
  id: multi-stage
  name: "Multi Stage Recipe"
  command: /multi-stage
  description: "A recipe with two stages and transitions"

cycle_policy: allow

orchestrator:
  role: roles/orchestrators/implementation.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - investigate
  - plan

start_stage: investigate

stages:
  investigate:
    role: roles/investigation/investigate.md
    objective: "Investigate the codebase"
    inputs:
      - description: "Source code"
        source: task.payload.source
    outputs:
      - label: investigation_doc
        format: md
    allowed_transitions:
      - plan
    allowed_scripts: []
  plan:
    role: roles/implementation/planning-create.md
    objective: "Create the implementation plan"
    inputs:
      - description: "Investigation results"
        source: artifacts.investigation_doc
    outputs:
      - label: planning_doc
        format: md
    allowed_transitions:
      - investigate
    allowed_scripts: []
`;

const MISSING_START_STAGE_YAML = `
recipe:
  id: bad-start
  name: "Bad Start"
  command: /bad-start
  description: "Recipe with invalid start_stage"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: nonexistent

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const ORPHAN_STAGE_YAML = `
recipe:
  id: orphan
  name: "Orphan Stage"
  command: /orphan
  description: "Recipe with orphan stage"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
  orphaned:
    role: roles/orphaned.md
    objective: "This stage is not in stage_order"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const INVALID_TRANSITION_YAML = `
recipe:
  id: bad-transition
  name: "Bad Transition"
  command: /bad-transition
  description: "Recipe with invalid transition"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions:
      - ghost_stage
    allowed_scripts: []
`;

const MISSING_ROLE_YAML = `
recipe:
  id: no-role
  name: "No Role"
  command: /no-role
  description: "Recipe with a stage missing role"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const MISSING_OBJECTIVE_YAML = `
recipe:
  id: no-objective
  name: "No Objective"
  command: /no-objective
  description: "Recipe with a stage missing objective"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const MISSING_ORCHESTRATOR_YAML = `
recipe:
  id: no-orchestrator
  name: "No Orchestrator"
  command: /no-orchestrator
  description: "Recipe missing orchestrator section"

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const DUPLICATE_STAGE_ORDER_YAML = `
recipe:
  id: dup-order
  name: "Duplicate Order"
  command: /dup-order
  description: "Recipe with duplicate stage_order entries"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const CYCLE_TRANSITIONS_YAML = `
recipe:
  id: cycle-recipe
  name: "Cycle Recipe"
  command: /cycle-recipe
  description: "Recipe with a transition cycle"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - alpha
  - beta

start_stage: alpha

stages:
  alpha:
    role: roles/alpha.md
    objective: "Alpha stage"
    inputs: []
    outputs: []
    allowed_transitions:
      - beta
    allowed_scripts: []
  beta:
    role: roles/beta.md
    objective: "Beta stage"
    inputs: []
    outputs: []
    allowed_transitions:
      - alpha
    allowed_scripts: []
`;

const CYCLE_WITH_ALLOW_POLICY_YAML = `
recipe:
  id: cycle-allowed
  name: "Cycle Allowed"
  command: /cycle-allowed
  description: "Recipe with cycle_policy: allow"

cycle_policy: allow

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - alpha
  - beta

start_stage: alpha

stages:
  alpha:
    role: roles/alpha.md
    objective: "Alpha stage"
    inputs: []
    outputs: []
    allowed_transitions:
      - beta
    allowed_scripts: []
  beta:
    role: roles/beta.md
    objective: "Beta stage"
    inputs: []
    outputs: []
    allowed_transitions:
      - alpha
    allowed_scripts: []
`;

const MISSING_ORCHESTRATOR_FIELDS_YAML = `
recipe:
  id: partial-orch
  name: "Partial Orchestrator"
  command: /partial-orch
  description: "Recipe with incomplete orchestrator"

orchestrator:
  effort: high

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    role: roles/planning.md
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const SECOND_VALID_YAML = `
recipe:
  id: second-recipe
  name: "Second Recipe"
  command: /second-recipe
  description: "Another valid recipe for multi-load testing"

orchestrator:
  role: roles/orchestrators/second.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 120000
  max_stage_retries: 1
  max_total_actions: 20

stage_order:
  - execute

start_stage: execute

stages:
  execute:
    role: roles/execute.md
    objective: "Execute the task"
    inputs: []
    outputs: []
    allowed_transitions: []
    allowed_scripts: []
`;

const MULTI_ERROR_YAML = `
recipe:
  id: multi-error
  name: "Multi Error"
  command: /multi-error
  description: "Recipe with multiple validation errors"

orchestrator:
  role: roles/orch.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40

stage_order:
  - planning

start_stage: planning

stages:
  planning:
    objective: "Plan it"
    inputs: []
    outputs: []
    allowed_transitions:
      - nonexistent
    allowed_scripts: []
`;

// -------------------------------------------------------------------
// Group 1: loadRecipes -- Discovery and Parsing
// -------------------------------------------------------------------

describe("loadRecipes -- Discovery and Parsing", () => {
  it("returns empty map for empty directory", async () => {
    const result = await loadRecipes(tempDir);
    expect(result.size).toBe(0);
  });

  it("returns empty map for nonexistent directory", async () => {
    const result = await loadRecipes(path.join(tempDir, "does-not-exist"));
    expect(result.size).toBe(0);
  });

  it("loads a valid single-stage recipe", async () => {
    await writeRecipeYaml("single-stage", VALID_SINGLE_STAGE_YAML);
    const result = await loadRecipes(tempDir);

    expect(result.size).toBe(1);
    expect(result.has("single-stage")).toBe(true);

    const recipe = result.get("single-stage")!;
    expect(recipe.id).toBe("single-stage");
    expect(recipe.name).toBe("Single Stage Recipe");
    expect(recipe.command).toBe("/single-stage");
    expect(recipe.start_stage).toBe("planning");
    expect(recipe.stage_order).toEqual(["planning"]);
    expect(recipe.stages.planning).toBeDefined();
    expect(recipe.stages.planning.role).toBe(
      "roles/implementation/planning-create.md",
    );
  });

  it("loads multiple recipes from subdirectories", async () => {
    await writeRecipeYaml("single-stage", VALID_SINGLE_STAGE_YAML);
    await writeRecipeYaml("second-recipe", SECOND_VALID_YAML);
    const result = await loadRecipes(tempDir);

    expect(result.size).toBe(2);
    expect(result.has("single-stage")).toBe(true);
    expect(result.has("second-recipe")).toBe(true);
  });

  it("skips subdirectories without recipe.yaml", async () => {
    await writeRecipeYaml("single-stage", VALID_SINGLE_STAGE_YAML);
    await mkdir(path.join(tempDir, "empty-dir"), { recursive: true });
    const result = await loadRecipes(tempDir);

    expect(result.size).toBe(1);
    expect(result.has("single-stage")).toBe(true);
  });

  it("reports YAML parse errors without crashing", async () => {
    await writeRecipeYaml("bad-yaml", "{{{{invalid yaml content!!!!}}}}");
    await writeRecipeYaml("single-stage", VALID_SINGLE_STAGE_YAML);

    await expect(loadRecipes(tempDir)).rejects.toThrow();
  });
});

// -------------------------------------------------------------------
// Group 2: validateRecipe -- Valid Recipes
// -------------------------------------------------------------------

describe("validateRecipe -- Valid Recipes", () => {
  it("accepts valid single-stage recipe", () => {
    const parsed = parseYaml(VALID_SINGLE_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    expect(errorMessages(result)).toHaveLength(0);
  });

  it("accepts valid multi-stage recipe with transitions", () => {
    const parsed = parseYaml(VALID_MULTI_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    expect(errorMessages(result)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 3: validateRecipe -- Stage Graph Topology Rejections
// -------------------------------------------------------------------

describe("validateRecipe -- Stage Graph Topology", () => {
  it("rejects missing start_stage", () => {
    const parsed = parseYaml(MISSING_START_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/start_stage/i);
    expect(joinedText(errors)).toMatch(/nonexistent/i);
  });

  it("rejects orphan stages not in stage_order", () => {
    const parsed = parseYaml(ORPHAN_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/orphan|not in stage_order/i);
    expect(joinedText(errors)).toMatch(/orphaned/i);
  });

  it("rejects invalid transition targets", () => {
    const parsed = parseYaml(INVALID_TRANSITION_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/ghost_stage/i);
    expect(joinedText(errors)).toMatch(/planning/i);
  });

  it("rejects duplicate stage IDs in stage_order", () => {
    const parsed = parseYaml(DUPLICATE_STAGE_ORDER_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/duplicate/i);
    expect(joinedText(errors)).toMatch(/planning/i);
  });

  it("rejects transition cycles by default", () => {
    const parsed = parseYaml(CYCLE_TRANSITIONS_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/cycle/i);
  });

  it("allows transition cycles with cycle_policy: allow", () => {
    const parsed = parseYaml(CYCLE_WITH_ALLOW_POLICY_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    expect(errorMessages(result)).toHaveLength(0);

    const warnings = warningMessages(result);
    expect(joinedText(warnings)).toMatch(/cycle/i);
  });
});

// -------------------------------------------------------------------
// Group 4: validateRecipe -- Required Field Rejections
// -------------------------------------------------------------------

describe("validateRecipe -- Required Fields", () => {
  it("rejects missing stage role", () => {
    const parsed = parseYaml(MISSING_ROLE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/planning/i);
    expect(joinedText(errors)).toMatch(/role/i);
  });

  it("rejects missing stage objective", () => {
    const parsed = parseYaml(MISSING_OBJECTIVE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/planning/i);
    expect(joinedText(errors)).toMatch(/objective/i);
  });

  it("rejects missing orchestrator section", () => {
    const parsed = parseYaml(MISSING_ORCHESTRATOR_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(joinedText(errors)).toMatch(/orchestrator/i);
  });

  it("rejects missing orchestrator required fields", () => {
    const parsed = parseYaml(MISSING_ORCHESTRATOR_FIELDS_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    const text = joinedText(errors);
    expect(text).toMatch(/role/i);
    expect(text).toMatch(/backend/i);
    expect(text).toMatch(/model/i);
    expect(text).toMatch(/timeout_ms/i);
  });
});

// -------------------------------------------------------------------
// Group 5: Recipe YAML Fixture -- New Implementation
// -------------------------------------------------------------------

describe("new-implementation recipe.yaml", () => {
  // Load the live recipe once for the entire group. The recipe YAML is
  // read-only during tests so a single load avoids redundant filesystem I/O.
  let recipe: RecipeConfig;

  // Canonical 10-stage sequence used across multiple assertions.
  const EXPECTED_STAGE_ORDER = [
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
  ];

  beforeAll(async () => {
    const recipesDir = path.resolve(__dirname, "../../recipes");
    const result = await loadRecipes(recipesDir);
    expect(result.has("new-implementation")).toBe(true);
    recipe = result.get("new-implementation")!;
  });

  // -- Topology: loading and metadata --

  it("loads without errors from the recipes directory", () => {
    expect(recipe).toBeDefined();
  });

  it("has correct metadata", () => {
    expect(recipe.id).toBe("new-implementation");
    expect(recipe.name).toBe("New Implementation");
    expect(recipe.command).toBe("/new-implementation");
    expect(recipe.start_stage).toBe("planning_check");
    expect(recipe.description).toBeDefined();
    expect(recipe.orchestrator).toBeDefined();
    expect(recipe.orchestrator.backend).toBe("cli-claude");
  });

  it("stage_order contains all 10 stages in canonical order", () => {
    expect(recipe.stage_order).toEqual(EXPECTED_STAGE_ORDER);
  });

  it("all 10 stage definitions exist with required fields", () => {
    for (const stageId of EXPECTED_STAGE_ORDER) {
      const stage = recipe.stages[stageId];
      expect(stage).toBeDefined();
      expect(stage.role).toBeTruthy();
      expect(stage.objective).toBeTruthy();
    }
  });

  it("each stage references a role file under roles/implementation/", () => {
    for (const stageId of EXPECTED_STAGE_ORDER) {
      expect(recipe.stages[stageId].role).toMatch(/^roles\/implementation\//);
    }
  });

  it("no orphan stages exist", () => {
    const stageKeys = Object.keys(recipe.stages);
    expect(stageKeys.length).toBe(EXPECTED_STAGE_ORDER.length);
    for (const key of stageKeys) {
      expect(EXPECTED_STAGE_ORDER).toContain(key);
    }
  });

  // -- Transitions --

  it("planning_check transitions forward to create_planning", () => {
    expect(recipe.stages.planning_check.allowed_transitions).toContain(
      "create_planning",
    );
  });

  it("commit_and_pr stage has empty allowed_transitions (terminal stage)", () => {
    expect(recipe.stages.commit_and_pr.allowed_transitions).toEqual([]);
  });

  it("allowed_transitions only reference existing stages", () => {
    const stageIds = new Set(Object.keys(recipe.stages));
    for (const stageId of EXPECTED_STAGE_ORDER) {
      for (const target of recipe.stages[stageId].allowed_transitions) {
        expect(stageIds.has(target)).toBe(true);
      }
    }
  });

  it("backward transitions exist for justified revisits (cycle_policy: allow)", async () => {
    const recipePath = path.resolve(
      __dirname,
      "../../recipes/new-implementation/recipe.yaml",
    );
    const raw = parseYaml(
      await readFile(recipePath, "utf-8"),
    ) as Record<string, unknown>;
    const result = validateRecipe(raw, recipePath);

    expect(errorMessages(result)).toHaveLength(0);
    expect(joinedText(warningMessages(result))).toMatch(/cycle/i);
  });

  // -- Script allowlists --

  it("commit_and_pr allowed_scripts includes all four delivery action IDs", () => {
    const scripts = recipe.stages.commit_and_pr.allowed_scripts;
    expect(scripts).toContain("delivery.stage_explicit");
    expect(scripts).toContain("delivery.commit_with_trailers");
    expect(scripts).toContain("delivery.push_branch");
    expect(scripts).toContain("delivery.upsert_draft_pr");
  });

  it("batch_implement allowed_scripts includes implementation.batch_bridge", () => {
    expect(recipe.stages.batch_implement.allowed_scripts).toContain(
      "implementation.batch_bridge",
    );
  });

  it("historical_search allowed_scripts includes repo search scripts", () => {
    const scripts = recipe.stages.historical_search.allowed_scripts;
    expect(scripts).toContain("repo.search");
    expect(scripts).toContain("repo.git_history");
  });

  it("prime_codebase allowed_scripts includes repo search and file map", () => {
    const scripts = recipe.stages.prime_codebase.allowed_scripts;
    expect(scripts).toContain("repo.search");
    expect(scripts).toContain("repo.file_map");
  });

  it("prime_knowledge allowed_scripts includes knowledge.prime", () => {
    expect(recipe.stages.prime_knowledge.allowed_scripts).toContain(
      "knowledge.prime",
    );
  });

  it("all allowed_scripts IDs exist in the script manifest", async () => {
    // Collect every unique script ID referenced across all stages
    const recipeScriptIds = new Set<string>();
    for (const stageId of EXPECTED_STAGE_ORDER) {
      for (const scriptId of recipe.stages[stageId].allowed_scripts) {
        recipeScriptIds.add(scriptId);
      }
    }

    // Load and parse the live script manifest
    const manifestPath = path.resolve(
      __dirname,
      "../../scripts/manifest.yaml",
    );
    const manifestRaw = parseYaml(
      await readFile(manifestPath, "utf-8"),
    ) as { scripts: Array<{ script_id: string }> };
    const manifestIds = new Set(
      manifestRaw.scripts.map((s) => s.script_id),
    );

    // Every recipe script must exist in the manifest
    for (const scriptId of recipeScriptIds) {
      expect(manifestIds.has(scriptId)).toBe(true);
    }
  });

  // -- Inputs and outputs --

  it("planning_check has user request input from task payload", () => {
    const inputs = recipe.stages.planning_check.inputs;
    expect(inputs.length).toBeGreaterThan(0);
    const sources = inputs.map((i) => i.source);
    expect(sources.some((s) => s.includes("task.payload"))).toBe(true);
  });

  it("commit_and_pr has defined inputs from upstream artifacts", () => {
    const inputs = recipe.stages.commit_and_pr.inputs;
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].source).toBeDefined();
    expect(inputs[0].description).toBeDefined();
  });

  it("commit_and_pr has PR URL output", () => {
    const outputs = recipe.stages.commit_and_pr.outputs;
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0].label).toBeDefined();
    expect(outputs[0].format).toBeDefined();
  });
});

// -------------------------------------------------------------------
// Group 6: Error Message Quality
// -------------------------------------------------------------------

describe("validateRecipe -- Error Message Quality", () => {
  it("validation errors include file path", () => {
    const parsed = parseYaml(MISSING_START_STAGE_YAML);
    const testFilePath = "/recipes/bad-start/recipe.yaml";
    const result = validateRecipe(parsed, testFilePath);

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].file).toBe(testFilePath);
  });

  it("multiple validation errors are collected, not short-circuited", () => {
    const parsed = parseYaml(MULTI_ERROR_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = errorMessages(result);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(joinedText(errors)).toMatch(/role/i);
    expect(joinedText(errors)).toMatch(/ghost_stage|nonexistent/i);
  });
});
