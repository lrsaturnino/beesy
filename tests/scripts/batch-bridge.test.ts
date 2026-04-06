import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadScriptRegistry } from "../../src/scripts/registry.js";
import { parseResultEnvelope } from "../../src/runtime/script-handler.js";
import { validateDecision } from "../../src/runtime/decision-validator.js";
import type { RecipeConfig, StageDefinition } from "../../src/recipes/types.js";

// -------------------------------------------------------------------
// Shared constants
// -------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..");

// -------------------------------------------------------------------
// Helper: check whether `uv` is available on the system
// -------------------------------------------------------------------

let uvAvailable = false;
try {
  execSync("uv --version", { encoding: "utf-8", stdio: "pipe" });
  uvAvailable = true;
} catch {
  uvAvailable = false;
}

// -------------------------------------------------------------------
// Temp workspace setup for subprocess tests
// -------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-bb-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// Group 1: Manifest Entry Validation
// -------------------------------------------------------------------

describe("implementation.batch_bridge manifest entry", () => {
  it("entry exists in manifest with all required metadata fields", async () => {
    const manifestPath = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");
    const registry = await loadScriptRegistry(manifestPath, PROJECT_ROOT);

    expect(registry.has("implementation.batch_bridge")).toBe(true);

    const entry = registry.get("implementation.batch_bridge")!;
    expect(entry.runtime).toBe("python");
    expect(entry.side_effects).toBe("workspace-write");
    expect(entry.required_env).toEqual([]);
    expect(entry.rerun_policy).toBe("refuse");
    expect(entry.timeout_ms).toBeGreaterThan(0);
    expect(entry.path).toBe("scripts/implementation/bees_batch_bridge.py");
  });

  it("script path resolves to a non-empty file (not just a placeholder comment)", async () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts",
      "implementation",
      "bees_batch_bridge.py",
    );
    const fileStat = await stat(scriptPath);
    expect(fileStat.isFile()).toBe(true);

    const content = await readFile(scriptPath, "utf-8");
    // Must contain actual implementation logic, not just a comment
    const meaningfulLines = content
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
    expect(meaningfulLines.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 2: Adapter Script stdin/stdout Contract
// -------------------------------------------------------------------

describe.skipIf(!uvAvailable)("batch_bridge adapter stdin/stdout contract", () => {
  it("accepts JSON stdin and produces valid JSON envelope on stdout", () => {
    const stdinPayload = JSON.stringify({
      task_state: {
        planning_doc: "## Plan\n- Step 1\n- Step 2",
        workspace: tempDir,
      },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "implementation", "bees_batch_bridge.py")}`,
      {
        input: stdinPayload,
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      },
    );

    const envelope = JSON.parse(stdout);
    expect(envelope).toHaveProperty("summary");
    expect(typeof envelope.summary).toBe("string");
    expect(envelope.summary.length).toBeGreaterThan(0);
  });

  it("envelope contains task pack output artifact with json format", () => {
    const stdinPayload = JSON.stringify({
      task_state: {
        planning_doc: "## Plan\n- Step 1\n- Step 2",
        workspace: tempDir,
      },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "implementation", "bees_batch_bridge.py")}`,
      {
        input: stdinPayload,
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      },
    );

    const envelope = JSON.parse(stdout);
    expect(envelope.outputs).toBeDefined();

    // Find the task pack artifact in the outputs map
    const outputKeys = Object.keys(envelope.outputs);
    expect(outputKeys.length).toBeGreaterThan(0);

    const taskPackKey = outputKeys.find(
      (key) => envelope.outputs[key].format === "json",
    );
    expect(taskPackKey).toBeDefined();
    expect(envelope.outputs[taskPackKey!].path).toBeDefined();
  });

  it("exits with non-zero on translation error from invalid input", () => {
    // Send empty/invalid planning data that cannot be translated
    const stdinPayload = JSON.stringify({
      task_state: {},
      input_patch: {},
    });

    let exitCode = 0;
    let stderr = "";
    try {
      execSync(
        `uv run ${path.join(PROJECT_ROOT, "scripts", "implementation", "bees_batch_bridge.py")}`,
        {
          input: stdinPayload,
          encoding: "utf-8",
          cwd: PROJECT_ROOT,
          timeout: 30_000,
        },
      );
    } catch (err: unknown) {
      const execError = err as { status: number; stderr: string };
      exitCode = execError.status;
      stderr = execError.stderr;
    }

    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("envelope is parseable by parseResultEnvelope without throwing", () => {
    const stdinPayload = JSON.stringify({
      task_state: {
        planning_doc: "## Plan\n- Step 1\n- Step 2",
        workspace: tempDir,
      },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "implementation", "bees_batch_bridge.py")}`,
      {
        input: stdinPayload,
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      },
    );

    const envelope = parseResultEnvelope(stdout);
    expect(envelope.summary).toBeDefined();
    expect(typeof envelope.summary).toBe("string");
    expect(envelope.summary.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 3: External Pipeline Asset Packaging
// -------------------------------------------------------------------

describe("external pipeline asset packaging", () => {
  it("mb-batch-implement directory exists", () => {
    const dirPath = path.join(
      PROJECT_ROOT,
      "scripts",
      "implementation",
      "mb-batch-implement",
    );
    expect(existsSync(dirPath)).toBe(true);
  });

  it("run_batch.py exists in mb-batch-implement directory", () => {
    const filePath = path.join(
      PROJECT_ROOT,
      "scripts",
      "implementation",
      "mb-batch-implement",
      "run_batch.py",
    );
    expect(existsSync(filePath)).toBe(true);
  });

  it("parse_dag.py exists in mb-batch-implement directory", () => {
    const filePath = path.join(
      PROJECT_ROOT,
      "scripts",
      "implementation",
      "mb-batch-implement",
      "parse_dag.py",
    );
    expect(existsSync(filePath)).toBe(true);
  });

  it("check_status.py exists in mb-batch-implement directory", () => {
    const filePath = path.join(
      PROJECT_ROOT,
      "scripts",
      "implementation",
      "mb-batch-implement",
      "check_status.py",
    );
    expect(existsSync(filePath)).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 4: Recipe Integration
// -------------------------------------------------------------------

describe("recipe integration for allowed_scripts", () => {
  it("new-implementation recipe YAML includes both scripts in planning stage", async () => {
    const recipeYamlPath = path.join(
      PROJECT_ROOT,
      "recipes",
      "new-implementation",
      "recipe.yaml",
    );
    const content = await readFile(recipeYamlPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    const stages = parsed.stages as Record<string, Record<string, unknown>>;
    expect(stages).toBeDefined();
    expect(stages.planning).toBeDefined();

    const allowedScripts = stages.planning.allowed_scripts as string[];
    expect(allowedScripts).toBeDefined();
    expect(Array.isArray(allowedScripts)).toBe(true);
    expect(allowedScripts).toContain("knowledge.prime");
    expect(allowedScripts).toContain("implementation.batch_bridge");
  });

  it("decision validator accepts run_script for knowledge.prime in planning stage", async () => {
    const manifestPath = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");
    const registry = await loadScriptRegistry(manifestPath, PROJECT_ROOT);

    // The manifest declares ANTHROPIC_API_KEY as required_env for knowledge.prime.
    // Set it temporarily so the env-requirements check passes deterministically
    // regardless of the host environment.
    const envKey = "ANTHROPIC_API_KEY";
    const savedValue = process.env[envKey];
    process.env[envKey] = savedValue ?? "test-placeholder";

    try {
      const recipe: RecipeConfig = {
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
            allowed_scripts: ["knowledge.prime", "implementation.batch_bridge"],
          } as StageDefinition,
        },
      };

      const decision = {
        action: "run_script" as const,
        script_id: "knowledge.prime",
        reasoning: "Prime knowledge context for planning",
      };

      const result = validateDecision(
        decision,
        recipe,
        "planning",
        {},
        0,
        new Set<string>(),
        registry,
      );

      expect(result.valid).toBe(true);
    } finally {
      // Restore original env state to avoid leaking into other tests
      if (savedValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = savedValue;
      }
    }
  });
});
