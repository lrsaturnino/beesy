import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadRecipes, validateRecipe } from "../../src/recipes/loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

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

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts valid multi-stage recipe with transitions", () => {
    const parsed = parseYaml(VALID_MULTI_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 3: validateRecipe -- Stage Graph Topology Rejections
// -------------------------------------------------------------------

describe("validateRecipe -- Stage Graph Topology", () => {
  it("rejects missing start_stage", () => {
    const parsed = parseYaml(MISSING_START_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/start_stage/i);
    expect(messages).toMatch(/nonexistent/i);
  });

  it("rejects orphan stages not in stage_order", () => {
    const parsed = parseYaml(ORPHAN_STAGE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/orphan|not in stage_order/i);
    expect(messages).toMatch(/orphaned/i);
  });

  it("rejects invalid transition targets", () => {
    const parsed = parseYaml(INVALID_TRANSITION_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/ghost_stage/i);
    expect(messages).toMatch(/planning/i);
  });

  it("rejects duplicate stage IDs in stage_order", () => {
    const parsed = parseYaml(DUPLICATE_STAGE_ORDER_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/duplicate/i);
    expect(messages).toMatch(/planning/i);
  });

  it("rejects transition cycles by default", () => {
    const parsed = parseYaml(CYCLE_TRANSITIONS_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/cycle/i);
  });

  it("allows transition cycles with cycle_policy: allow", () => {
    const parsed = parseYaml(CYCLE_WITH_ALLOW_POLICY_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors).toHaveLength(0);

    const warnings = result.filter(
      (m: { severity: string }) => m.severity === "warning",
    );
    const warningMessages = warnings
      .map((w: { message: string }) => w.message)
      .join(" ");
    expect(warningMessages).toMatch(/cycle/i);
  });
});

// -------------------------------------------------------------------
// Group 4: validateRecipe -- Required Field Rejections
// -------------------------------------------------------------------

describe("validateRecipe -- Required Fields", () => {
  it("rejects missing stage role", () => {
    const parsed = parseYaml(MISSING_ROLE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/planning/i);
    expect(messages).toMatch(/role/i);
  });

  it("rejects missing stage objective", () => {
    const parsed = parseYaml(MISSING_OBJECTIVE_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/planning/i);
    expect(messages).toMatch(/objective/i);
  });

  it("rejects missing orchestrator section", () => {
    const parsed = parseYaml(MISSING_ORCHESTRATOR_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/orchestrator/i);
  });

  it("rejects missing orchestrator required fields", () => {
    const parsed = parseYaml(MISSING_ORCHESTRATOR_FIELDS_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/role/i);
    expect(messages).toMatch(/backend/i);
    expect(messages).toMatch(/model/i);
    expect(messages).toMatch(/timeout_ms/i);
  });
});

// -------------------------------------------------------------------
// Group 5: Recipe YAML Fixture -- New Implementation
// -------------------------------------------------------------------

describe("new-implementation recipe.yaml", () => {
  it("loads without errors from the recipes directory", async () => {
    const recipesDir = path.resolve(__dirname, "../../recipes");
    const result = await loadRecipes(recipesDir);
    expect(result.has("new-implementation")).toBe(true);
  });

  it("has correct metadata", async () => {
    const recipesDir = path.resolve(__dirname, "../../recipes");
    const result = await loadRecipes(recipesDir);
    const recipe = result.get("new-implementation")!;

    expect(recipe.id).toBe("new-implementation");
    expect(recipe.name).toBe("New Implementation");
    expect(recipe.command).toBe("/new-implementation");
    expect(recipe.start_stage).toBe("planning");
    expect(recipe.description).toBeDefined();
    expect(recipe.orchestrator).toBeDefined();
    expect(recipe.orchestrator.backend).toBe("cli-claude");
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

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].file).toBe(testFilePath);
  });

  it("multiple validation errors are collected, not short-circuited", () => {
    const parsed = parseYaml(MULTI_ERROR_YAML);
    const result = validateRecipe(parsed, "test.yaml");

    const errors = result.filter(
      (m: { severity: string }) => m.severity === "error",
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);

    const messages = errors.map((e: { message: string }) => e.message).join(" ");
    expect(messages).toMatch(/role/i);
    expect(messages).toMatch(/ghost_stage|nonexistent/i);
  });
});
