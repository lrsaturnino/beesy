import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadScriptRegistry } from "../../src/scripts/registry.js";

/**
 * Resolve the project root so tests operate on the actual manifest and
 * actual script files rather than temporary fixtures. This validates
 * production artifacts directly.
 */
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");

/**
 * All 8 original script IDs that existed before hardening. Used to verify
 * no regressions after manifest changes.
 */
const ORIGINAL_SCRIPT_IDS = [
  "knowledge.prime",
  "implementation.batch_bridge",
  "monitoring.check_health",
  "monitoring.aggregate_metrics",
  "delivery.stage_explicit",
  "delivery.commit_with_trailers",
  "delivery.push_branch",
  "delivery.upsert_draft_pr",
] as const;

/**
 * Runtime types for the 8 original scripts, indexed by script_id.
 * Used to verify no runtime metadata was accidentally changed.
 */
const ORIGINAL_RUNTIMES: Record<string, string> = {
  "knowledge.prime": "python",
  "implementation.batch_bridge": "python",
  "monitoring.check_health": "shell",
  "monitoring.aggregate_metrics": "shell",
  "delivery.stage_explicit": "internal",
  "delivery.commit_with_trailers": "internal",
  "delivery.push_branch": "internal",
  "delivery.upsert_draft_pr": "internal",
};

const NEW_REPO_SCRIPT_IDS = [
  "repo.search",
  "repo.git_history",
  "repo.file_map",
] as const;

// -------------------------------------------------------------------
// Group 1: Manifest Structure Completeness
// -------------------------------------------------------------------

describe("Manifest Structure Completeness", () => {
  it("manifest contains exactly 11 script entries after hardening", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    expect(registry.size).toBe(11);
  });

  it("manifest contains all three repo.* script entries", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const scriptId of NEW_REPO_SCRIPT_IDS) {
      expect(
        registry.has(scriptId),
        `Expected registry to contain "${scriptId}"`,
      ).toBe(true);
    }
  });

  it("every script entry has all required fields populated", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const [scriptId, entry] of registry) {
      expect(typeof entry.script_id).toBe("string");
      expect(entry.script_id.length).toBeGreaterThan(0);

      expect(typeof entry.description).toBe("string");
      expect(
        entry.description.length,
        `${scriptId}: description should be non-empty`,
      ).toBeGreaterThan(0);

      expect(typeof entry.runtime).toBe("string");
      expect(["python", "node", "shell", "internal"]).toContain(entry.runtime);

      expect(typeof entry.path).toBe("string");
      expect(entry.path.length).toBeGreaterThan(0);

      expect(typeof entry.timeout_ms).toBe("number");
      expect(
        entry.timeout_ms,
        `${scriptId}: timeout_ms should be positive`,
      ).toBeGreaterThan(0);

      expect(typeof entry.retryable).toBe("boolean");

      expect(typeof entry.side_effects).toBe("string");
      expect(["read-only", "workspace-write", "external-write"]).toContain(
        entry.side_effects,
      );

      expect(Array.isArray(entry.required_env)).toBe(true);

      expect(typeof entry.rerun_policy).toBe("string");
      expect(["restart", "continue", "refuse"]).toContain(entry.rerun_policy);
    }
  });
});

// -------------------------------------------------------------------
// Group 2: Orchestrator Notes Quality
// -------------------------------------------------------------------

describe("Orchestrator Notes Quality", () => {
  it("every script has orchestrator_notes with when-to-use guidance", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const [scriptId, entry] of registry) {
      expect(
        typeof entry.orchestrator_notes,
        `${scriptId}: orchestrator_notes should be a string`,
      ).toBe("string");
      expect(
        entry.orchestrator_notes!.length,
        `${scriptId}: orchestrator_notes should be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("orchestrator_notes contain anti-pattern (when-not) guidance", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    const negativeKeywords = [
      "not",
      "avoid",
      "never",
      "unnecessary",
      "skip",
      "don't",
      "do not",
      "without",
    ];

    for (const [scriptId, entry] of registry) {
      const notes = (entry.orchestrator_notes ?? "").toLowerCase();
      const hasNegativeGuidance = negativeKeywords.some((keyword) =>
        notes.includes(keyword),
      );
      expect(
        hasNegativeGuidance,
        `${scriptId}: orchestrator_notes should contain when-NOT-to-use guidance (none of: ${negativeKeywords.join(", ")} found in: "${entry.orchestrator_notes}")`,
      ).toBe(true);
    }
  });
});

// -------------------------------------------------------------------
// Group 3: Repo Script Metadata
// -------------------------------------------------------------------

describe("Repo Script Metadata", () => {
  it("repo.search has correct runtime, side_effects, and retryability", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    const entry = registry.get("repo.search")!;

    expect(entry).toBeDefined();
    expect(entry.runtime).toBe("shell");
    expect(entry.side_effects).toBe("read-only");
    expect(entry.retryable).toBe(true);
    expect(entry.rerun_policy).toBe("restart");
  });

  it("repo.git_history has correct runtime, side_effects, and retryability", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    const entry = registry.get("repo.git_history")!;

    expect(entry).toBeDefined();
    expect(entry.runtime).toBe("shell");
    expect(entry.side_effects).toBe("read-only");
    expect(entry.retryable).toBe(true);
    expect(entry.rerun_policy).toBe("restart");
  });

  it("repo.file_map has correct runtime, side_effects, and retryability", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    const entry = registry.get("repo.file_map")!;

    expect(entry).toBeDefined();
    expect(entry.runtime).toBe("shell");
    expect(entry.side_effects).toBe("read-only");
    expect(entry.retryable).toBe(true);
    expect(entry.rerun_policy).toBe("restart");
  });

  it("all repo.* scripts have no required_env dependencies", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const scriptId of NEW_REPO_SCRIPT_IDS) {
      const entry = registry.get(scriptId)!;
      expect(entry).toBeDefined();
      expect(
        entry.required_env,
        `${scriptId}: required_env should be empty`,
      ).toEqual([]);
    }
  });
});

// -------------------------------------------------------------------
// Group 4: Schema Validation
// -------------------------------------------------------------------

describe("Schema Validation", () => {
  it("repo.search has input_schema with required query field", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);
    const entry = registry.get("repo.search")!;

    expect(entry).toBeDefined();
    expect(entry.input_schema).toBeDefined();
    expect(
      (entry.input_schema as Record<string, unknown>).properties,
    ).toBeDefined();

    const properties = (entry.input_schema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(properties.query).toBeDefined();
  });

  it("all repo.* scripts have output_schema defining summary field", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const scriptId of NEW_REPO_SCRIPT_IDS) {
      const entry = registry.get(scriptId)!;
      expect(entry).toBeDefined();
      expect(
        entry.output_schema,
        `${scriptId}: output_schema should be defined`,
      ).toBeDefined();

      const properties = (entry.output_schema as Record<string, unknown>)
        .properties as Record<string, unknown>;
      expect(
        properties.summary,
        `${scriptId}: output_schema should define summary`,
      ).toBeDefined();
    }
  });
});

// -------------------------------------------------------------------
// Group 5: Script Executability (Integration)
// -------------------------------------------------------------------

describe("Script Executability", () => {
  it("repo.search produces valid ScriptResultEnvelope when invoked", () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts", "repo", "search.sh");
    const stdin = JSON.stringify({
      task_state: {},
      input_patch: { query: "test", path: "." },
    });

    const stdout = execSync(`echo '${stdin}' | bash "${scriptPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });

    const result = JSON.parse(stdout.trim());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("repo.git_history produces valid ScriptResultEnvelope when invoked", () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts",
      "repo",
      "git_history.sh",
    );
    const stdin = JSON.stringify({
      task_state: {},
      input_patch: { path: ".", mode: "log" },
    });

    const stdout = execSync(`echo '${stdin}' | bash "${scriptPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });

    const result = JSON.parse(stdout.trim());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("repo.file_map produces valid ScriptResultEnvelope when invoked", () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts",
      "repo",
      "file_map.sh",
    );
    const stdin = JSON.stringify({
      task_state: {},
      input_patch: { path: ".", depth: 2 },
    });

    const stdout = execSync(`echo '${stdin}' | bash "${scriptPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });

    const result = JSON.parse(stdout.trim());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("repo.search returns results matching grep output for known pattern", () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts", "repo", "search.sh");
    const stdin = JSON.stringify({
      task_state: {},
      input_patch: { query: "loadScriptRegistry", path: "src" },
    });

    const stdout = execSync(`echo '${stdin}' | bash "${scriptPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });

    const result = JSON.parse(stdout.trim());
    expect(result.state_patch).toBeDefined();
    expect(Array.isArray(result.state_patch.matches)).toBe(true);
    expect(result.state_patch.matches.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 6: Cross-Reference with Recipe
// -------------------------------------------------------------------

describe("Cross-Reference with Recipe", () => {
  it("all script_ids referenced in recipe allowed_scripts exist in manifest", async () => {
    const recipePath = path.join(
      PROJECT_ROOT,
      "recipes",
      "new-implementation",
      "recipe.yaml",
    );
    const recipeContent = readFileSync(recipePath, "utf-8");
    const recipe = parseYaml(recipeContent) as Record<string, unknown>;

    const stages = recipe.stages as Record<
      string,
      Record<string, unknown>
    >;

    const referencedScripts = new Set<string>();
    for (const stage of Object.values(stages)) {
      const allowed = stage.allowed_scripts as string[] | undefined;
      if (Array.isArray(allowed)) {
        for (const scriptId of allowed) {
          referencedScripts.add(scriptId);
        }
      }
    }

    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const scriptId of referencedScripts) {
      expect(
        registry.has(scriptId),
        `Script "${scriptId}" referenced in recipe but not found in manifest`,
      ).toBe(true);
    }
  });
});

// -------------------------------------------------------------------
// Group 7: Regression Safety
// -------------------------------------------------------------------

describe("Regression Safety", () => {
  it("existing 8 scripts remain loadable after manifest changes", async () => {
    const registry = await loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT);

    for (const scriptId of ORIGINAL_SCRIPT_IDS) {
      expect(
        registry.has(scriptId),
        `Original script "${scriptId}" should still be present`,
      ).toBe(true);

      const entry = registry.get(scriptId)!;
      expect(
        entry.runtime,
        `${scriptId}: runtime should still be "${ORIGINAL_RUNTIMES[scriptId]}"`,
      ).toBe(ORIGINAL_RUNTIMES[scriptId]);
    }
  });

  it("manifest YAML parses without errors", async () => {
    await expect(
      loadScriptRegistry(MANIFEST_PATH, PROJECT_ROOT),
    ).resolves.not.toThrow();
  });
});
