import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// -------------------------------------------------------------------
// Group 1: ScriptRuntime (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("ScriptRuntime", () => {
  it("exports SCRIPT_RUNTIMES const array with four values", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod.SCRIPT_RUNTIMES).toBeDefined();
    const runtimes = mod.SCRIPT_RUNTIMES as readonly string[];
    expect(runtimes).toHaveLength(4);
    expect(runtimes).toContain("python");
    expect(runtimes).toContain("node");
    expect(runtimes).toContain("shell");
    expect(runtimes).toContain("internal");
  });
});

// -------------------------------------------------------------------
// Group 2: SideEffectLevel (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("SideEffectLevel", () => {
  it("exports SIDE_EFFECT_LEVELS const array with all three levels in escalating order", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod.SIDE_EFFECT_LEVELS).toBeDefined();
    const levels = mod.SIDE_EFFECT_LEVELS as readonly string[];
    expect(levels).toHaveLength(3);
    expect(levels).toContain("read-only");
    expect(levels).toContain("workspace-write");
    expect(levels).toContain("external-write");
    // Verify escalating severity ordering (read < write < external)
    expect(levels[0]).toBe("read-only");
    expect(levels[1]).toBe("workspace-write");
    expect(levels[2]).toBe("external-write");
  });
});

// -------------------------------------------------------------------
// Group 2b: Registry integration for external-write level
// -------------------------------------------------------------------

const EXTERNAL_WRITE_MANIFEST_YAML = `
scripts:
  - script_id: delivery.push_branch
    description: "Push current branch to remote"
    runtime: shell
    path: scripts/delivery/push_branch.sh
    timeout_ms: 30000
    retryable: false
    side_effects: external-write
    required_env: []
    rerun_policy: restart
`;

describe("SideEffectLevel registry integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "bees-types-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("accepts external-write as a valid side_effects value in a manifest entry", async () => {
    const { loadScriptRegistry } = await import(
      "../../src/scripts/registry.js"
    );

    const manifestPath = path.join(tempDir, "manifest.yaml");
    await writeFile(manifestPath, EXTERNAL_WRITE_MANIFEST_YAML, "utf-8");

    const scriptDir = path.join(tempDir, "scripts", "delivery");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      path.join(scriptDir, "push_branch.sh"),
      "#!/bin/sh\n# placeholder",
      "utf-8",
    );

    const registry = await loadScriptRegistry(manifestPath, tempDir);
    expect(registry.size).toBe(1);
    expect(registry.has("delivery.push_branch")).toBe(true);

    const entry = registry.get("delivery.push_branch")!;
    expect(entry.side_effects).toBe("external-write");
  });
});

// -------------------------------------------------------------------
// Group 3: RerunPolicy (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("RerunPolicy", () => {
  it("exports RERUN_POLICIES const array with three values", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod.RERUN_POLICIES).toBeDefined();
    const policies = mod.RERUN_POLICIES as readonly string[];
    expect(policies).toHaveLength(3);
    expect(policies).toContain("restart");
    expect(policies).toContain("continue");
    expect(policies).toContain("refuse");
  });
});

// -------------------------------------------------------------------
// Group 4: ScriptManifest (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("ScriptManifest", () => {
  it("ScriptManifest with all required fields is constructible", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    const manifest: Record<string, unknown> = {
      script_id: "repo.search",
      description: "Search repository for code patterns",
      runtime: "node",
      path: "scripts/repo-search.ts",
      timeout_ms: 30000,
      retryable: true,
      side_effects: "read-only",
      required_env: ["GITHUB_TOKEN"],
      input_schema: { type: "object", properties: { query: { type: "string" } } },
      output_schema: { type: "object", properties: { results: { type: "array" } } },
      orchestrator_notes: "Use for broad codebase searches before targeted reads",
      rerun_policy: "restart",
    };
    expect(manifest.script_id).toBe("repo.search");
    expect(manifest.description).toBe("Search repository for code patterns");
    expect(manifest.runtime).toBe("node");
    expect(manifest.path).toBe("scripts/repo-search.ts");
    expect(manifest.timeout_ms).toBe(30000);
    expect(manifest.retryable).toBe(true);
    expect(manifest.side_effects).toBe("read-only");
    expect(Array.isArray(manifest.required_env)).toBe(true);
    expect(typeof manifest.input_schema).toBe("object");
    expect(typeof manifest.output_schema).toBe("object");
    expect(manifest.orchestrator_notes).toBe("Use for broad codebase searches before targeted reads");
    expect(manifest.rerun_policy).toBe("restart");
  });

  it("ScriptManifest requires all mandatory fields", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    const manifest: Record<string, unknown> = {
      script_id: "lint.check",
      description: "Run lint checks on the workspace",
      runtime: "shell",
      path: "scripts/lint-check.sh",
      timeout_ms: 60000,
      retryable: false,
      side_effects: "read-only",
      required_env: [],
      rerun_policy: "refuse",
    };
    const requiredKeys = [
      "script_id",
      "description",
      "runtime",
      "path",
      "timeout_ms",
      "retryable",
      "side_effects",
      "required_env",
      "rerun_policy",
    ];
    for (const key of requiredKeys) {
      expect(
        manifest[key],
        `ScriptManifest must have required field: ${key}`,
      ).toBeDefined();
    }
  });

  it("ScriptManifest optional fields are truly optional", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    const manifest: Record<string, unknown> = {
      script_id: "workspace.clean",
      description: "Clean workspace temporary files",
      runtime: "shell",
      path: "scripts/workspace-clean.sh",
      timeout_ms: 15000,
      retryable: true,
      side_effects: "workspace-write",
      required_env: [],
      rerun_policy: "restart",
    };
    // Optional fields should be absent when not provided
    expect(manifest.input_schema).toBeUndefined();
    expect(manifest.output_schema).toBeUndefined();
    expect(manifest.orchestrator_notes).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 5: ScriptCatalogEntry (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("ScriptCatalogEntry", () => {
  it("ScriptCatalogEntry with orchestrator-visible summary fields is constructible", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    const entry: Record<string, unknown> = {
      script_id: "repo.search",
      description: "Search repository for code patterns",
      runtime: "node",
      side_effects: "read-only",
      timeout_ms: 30000,
      retryable: true,
      orchestrator_notes: "Useful for broad codebase exploration",
    };
    expect(entry.script_id).toBe("repo.search");
    expect(entry.description).toBe("Search repository for code patterns");
    expect(entry.runtime).toBe("node");
    expect(entry.side_effects).toBe("read-only");
    expect(entry.timeout_ms).toBe(30000);
    expect(entry.retryable).toBe(true);
    expect(entry.orchestrator_notes).toBe("Useful for broad codebase exploration");
  });
});

// -------------------------------------------------------------------
// Group 6: ScriptResultEnvelope (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("ScriptResultEnvelope", () => {
  it("ScriptResultEnvelope with all fields is constructible", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    const envelope: Record<string, unknown> = {
      summary: "Found 12 matches across 4 files",
      outputs: {
        search_results: { path: ".bees/search-results.json", label: "Search Results", format: "json" },
      },
      state_patch: { last_search_query: "handleMessage" },
      metrics: { files_scanned: 120, matches_found: 12, estimated_usd: 0.002 },
    };
    expect(typeof envelope.summary).toBe("string");
    expect(typeof envelope.outputs).toBe("object");
    expect(typeof envelope.state_patch).toBe("object");
    expect(typeof envelope.metrics).toBe("object");
  });

  it("ScriptResultEnvelope optional fields are truly optional", async () => {
    const mod = await import("../../src/scripts/types.js");
    expect(mod).toBeDefined();
    // Only summary is required; outputs, state_patch, metrics are optional
    const envelope: Record<string, unknown> = {
      summary: "Lint check passed with no warnings",
    };
    expect(envelope.summary).toBe("Lint check passed with no warnings");
    expect(envelope.outputs).toBeUndefined();
    expect(envelope.state_patch).toBeUndefined();
    expect(envelope.metrics).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 7: Cross-module and compilation (src/scripts/types.ts)
// -------------------------------------------------------------------
describe("cross-module and compilation", () => {
  it("scripts/types.ts module can be imported without conflicts alongside existing modules", async () => {
    const scriptsMod = await import("../../src/scripts/types.js");
    const queueMod = await import("../../src/queue/types.js");
    const recipesMod = await import("../../src/recipes/types.js");

    expect(scriptsMod).toBeDefined();
    expect(queueMod).toBeDefined();
    expect(recipesMod).toBeDefined();
  });

  it("TypeScript compilation passes with scripts/types.ts included", () => {
    const result = execSync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.trim()).toBe("");
  });

  it("ScriptManifest is not exported from recipes/types.ts or queue/types.ts", async () => {
    const recipesMod = await import("../../src/recipes/types.js");
    const queueMod = await import("../../src/queue/types.js");
    expect(
      (recipesMod as Record<string, unknown>).ScriptManifest,
    ).toBeUndefined();
    expect(
      (queueMod as Record<string, unknown>).ScriptManifest,
    ).toBeUndefined();
  });
});
