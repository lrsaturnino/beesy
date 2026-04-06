import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadScriptRegistry,
  resolveScript,
  buildCatalogSummary,
  validateEnvRequirements,
} from "../../src/scripts/registry.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-registry-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Write a manifest YAML file and create placeholder script files in
 * the temp directory so path validation passes during loading.
 */
async function writeManifest(
  content: string,
  scriptPaths: string[] = [],
): Promise<string> {
  const manifestPath = path.join(tempDir, "manifest.yaml");
  await writeFile(manifestPath, content, "utf-8");

  for (const scriptPath of scriptPaths) {
    const fullPath = path.join(tempDir, scriptPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "# placeholder", "utf-8");
  }

  return manifestPath;
}

// -------------------------------------------------------------------
// YAML fixture constants
// -------------------------------------------------------------------

const VALID_SINGLE_SCRIPT_YAML = `
scripts:
  - script_id: knowledge.prime
    description: "Prime knowledge context from repository analysis"
    runtime: python
    path: scripts/knowledge/prime_knowledge.py
    timeout_ms: 300000
    retryable: true
    side_effects: read-only
    required_env:
      - ANTHROPIC_API_KEY
    orchestrator_notes: "Run early in a workflow to establish codebase context"
    rerun_policy: restart
`;

const VALID_MULTI_SCRIPT_YAML = `
scripts:
  - script_id: knowledge.prime
    description: "Prime knowledge context from repository analysis"
    runtime: python
    path: scripts/knowledge/prime_knowledge.py
    timeout_ms: 300000
    retryable: true
    side_effects: read-only
    required_env:
      - ANTHROPIC_API_KEY
    orchestrator_notes: "Run early in a workflow to establish codebase context"
    rerun_policy: restart
  - script_id: implementation.batch_bridge
    description: "Translate planning artifacts into task packs"
    runtime: python
    path: scripts/implementation/bees_batch_bridge.py
    timeout_ms: 120000
    retryable: false
    side_effects: workspace-write
    required_env: []
    orchestrator_notes: "Run after planning stage to generate task packs"
    rerun_policy: refuse
`;

const VALID_MINIMAL_FIELDS_YAML = `
scripts:
  - script_id: minimal.script
    description: "A script with only required fields"
    runtime: node
    path: scripts/minimal.js
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    rerun_policy: continue
`;

const DUPLICATE_ID_YAML = `
scripts:
  - script_id: duplicate.script
    description: "First occurrence"
    runtime: python
    path: scripts/first.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    rerun_policy: restart
  - script_id: duplicate.script
    description: "Second occurrence with same ID"
    runtime: node
    path: scripts/second.js
    timeout_ms: 20000
    retryable: true
    side_effects: workspace-write
    required_env: []
    rerun_policy: refuse
`;

const MISSING_REQUIRED_FIELDS_YAML = `
scripts:
  - script_id: incomplete.script
    path: scripts/incomplete.py
    timeout_ms: 10000
    retryable: false
    required_env: []
`;

const NONEXISTENT_PATH_YAML = `
scripts:
  - script_id: bad.path
    description: "Script with nonexistent path"
    runtime: python
    path: scripts/nonexistent.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    rerun_policy: restart
`;

const INVALID_SIDE_EFFECTS_YAML = `
scripts:
  - script_id: bad.side_effects
    description: "Script with invalid side_effects"
    runtime: python
    path: scripts/bad_effects.py
    timeout_ms: 10000
    retryable: false
    side_effects: dangerous
    required_env: []
    rerun_policy: restart
`;

const INVALID_RUNTIME_YAML = `
scripts:
  - script_id: bad.runtime
    description: "Script with invalid runtime"
    runtime: ruby
    path: scripts/bad_runtime.rb
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    rerun_policy: restart
`;

const INVALID_RERUN_POLICY_YAML = `
scripts:
  - script_id: bad.rerun
    description: "Script with invalid rerun_policy"
    runtime: python
    path: scripts/bad_rerun.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    rerun_policy: maybe
`;

const MULTIPLE_ERRORS_YAML = `
scripts:
  - script_id: multi.error
    description: "Script with multiple validation failures"
    runtime: ruby
    path: scripts/nonexistent_multi.py
    timeout_ms: 10000
    retryable: false
    side_effects: dangerous
    required_env: []
    rerun_policy: maybe
`;

const EMPTY_SCRIPTS_YAML = `
scripts: []
`;

const NULL_SCRIPTS_YAML = `
scripts:
`;

const ENV_REQUIRED_YAML = `
scripts:
  - script_id: env.check
    description: "Script requiring env vars"
    runtime: python
    path: scripts/env_check.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env:
      - VAR_A
      - VAR_B
    rerun_policy: restart
`;

const NO_ORCHESTRATOR_NOTES_YAML = `
scripts:
  - script_id: with.notes
    description: "Has orchestrator notes"
    runtime: python
    path: scripts/with_notes.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env: []
    orchestrator_notes: "These are orchestrator notes"
    rerun_policy: restart
  - script_id: without.notes
    description: "No orchestrator notes"
    runtime: node
    path: scripts/without_notes.js
    timeout_ms: 20000
    retryable: true
    side_effects: workspace-write
    required_env: []
    rerun_policy: continue
`;

// -------------------------------------------------------------------
// Group 1: loadScriptRegistry -- Valid Manifests
// -------------------------------------------------------------------

describe("loadScriptRegistry -- Valid Manifests", () => {
  it("loads a valid manifest with one script entry", async () => {
    const manifestPath = await writeManifest(VALID_SINGLE_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    expect(registry.size).toBe(1);
    expect(registry.has("knowledge.prime")).toBe(true);

    const entry = registry.get("knowledge.prime")!;
    expect(entry.script_id).toBe("knowledge.prime");
    expect(entry.description).toBe("Prime knowledge context from repository analysis");
    expect(entry.runtime).toBe("python");
    expect(entry.path).toBe("scripts/knowledge/prime_knowledge.py");
    expect(entry.timeout_ms).toBe(300000);
    expect(entry.retryable).toBe(true);
    expect(entry.side_effects).toBe("read-only");
    expect(entry.required_env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(entry.rerun_policy).toBe("restart");
  });

  it("loads a valid manifest with multiple script entries", async () => {
    const manifestPath = await writeManifest(VALID_MULTI_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
      "scripts/implementation/bees_batch_bridge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    expect(registry.size).toBe(2);
    expect(registry.has("knowledge.prime")).toBe(true);
    expect(registry.has("implementation.batch_bridge")).toBe(true);

    const prime = registry.get("knowledge.prime")!;
    expect(prime.runtime).toBe("python");

    const bridge = registry.get("implementation.batch_bridge")!;
    expect(bridge.runtime).toBe("python");
    expect(bridge.side_effects).toBe("workspace-write");
  });

  it("handles optional fields correctly when absent", async () => {
    const manifestPath = await writeManifest(VALID_MINIMAL_FIELDS_YAML, [
      "scripts/minimal.js",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    expect(registry.size).toBe(1);
    const entry = registry.get("minimal.script")!;
    expect(entry.input_schema).toBeUndefined();
    expect(entry.output_schema).toBeUndefined();
    expect(entry.orchestrator_notes).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 2: loadScriptRegistry -- Validation Errors
// -------------------------------------------------------------------

describe("loadScriptRegistry -- Validation Errors", () => {
  it("rejects duplicate script IDs", async () => {
    const manifestPath = await writeManifest(DUPLICATE_ID_YAML, [
      "scripts/first.py",
      "scripts/second.js",
    ]);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow(/duplicate/i);
  });

  it("rejects missing required fields", async () => {
    const manifestPath = await writeManifest(MISSING_REQUIRED_FIELDS_YAML, [
      "scripts/incomplete.py",
    ]);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow();

    try {
      await loadScriptRegistry(manifestPath, tempDir);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/description|runtime|side_effects|rerun_policy/i);
    }
  });

  it("rejects non-existent script paths", async () => {
    // Deliberately do NOT create the script file
    const manifestPath = await writeManifest(NONEXISTENT_PATH_YAML, []);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow(/nonexistent\.py|path/i);
  });

  it("rejects invalid side-effect levels", async () => {
    const manifestPath = await writeManifest(INVALID_SIDE_EFFECTS_YAML, [
      "scripts/bad_effects.py",
    ]);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow(/side_effects|dangerous/i);
  });

  it("rejects invalid runtime values", async () => {
    const manifestPath = await writeManifest(INVALID_RUNTIME_YAML, [
      "scripts/bad_runtime.rb",
    ]);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow(/runtime|ruby/i);
  });

  it("rejects invalid rerun_policy values", async () => {
    const manifestPath = await writeManifest(INVALID_RERUN_POLICY_YAML, [
      "scripts/bad_rerun.py",
    ]);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow(/rerun_policy|maybe/i);
  });

  it("collects multiple validation errors in a single pass", async () => {
    const manifestPath = await writeManifest(MULTIPLE_ERRORS_YAML, []);

    try {
      await loadScriptRegistry(manifestPath, tempDir);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      // Should mention multiple field issues, not just the first one
      expect(message).toMatch(/runtime|ruby/i);
      expect(message).toMatch(/side_effects|dangerous/i);
      expect(message).toMatch(/rerun_policy|maybe/i);
    }
  });

  it("rejects empty manifest with no scripts", async () => {
    const manifestPath = await writeManifest(EMPTY_SCRIPTS_YAML, []);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow();
  });

  it("rejects null scripts section", async () => {
    const manifestPath = await writeManifest(NULL_SCRIPTS_YAML, []);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow();
  });

  it("rejects malformed YAML content", async () => {
    const manifestPath = await writeManifest("{{{{invalid yaml!!!!}}}}", []);

    await expect(
      loadScriptRegistry(manifestPath, tempDir),
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------------
// Group 3: resolveScript
// -------------------------------------------------------------------

describe("resolveScript", () => {
  it("returns correct ScriptManifest for existing script ID", async () => {
    const manifestPath = await writeManifest(VALID_SINGLE_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = resolveScript(registry, "knowledge.prime");
    expect(result).not.toBeNull();
    expect(result!.script_id).toBe("knowledge.prime");
    expect(result!.description).toBe("Prime knowledge context from repository analysis");
    expect(result!.runtime).toBe("python");
  });

  it("returns null for non-existent script ID", async () => {
    const manifestPath = await writeManifest(VALID_SINGLE_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = resolveScript(registry, "nonexistent.script");
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 4: buildCatalogSummary
// -------------------------------------------------------------------

describe("buildCatalogSummary", () => {
  it("returns ScriptCatalogEntry array with correct field mapping", async () => {
    const manifestPath = await writeManifest(VALID_MULTI_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
      "scripts/implementation/bees_batch_bridge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const catalog = buildCatalogSummary(registry);
    expect(catalog).toHaveLength(2);

    const prime = catalog.find((e) => e.script_id === "knowledge.prime")!;
    expect(prime).toBeDefined();
    expect(prime.script_id).toBe("knowledge.prime");
    expect(prime.description).toBe("Prime knowledge context from repository analysis");
    expect(prime.runtime).toBe("python");
    expect(prime.side_effects).toBe("read-only");
    expect(prime.timeout_ms).toBe(300000);
    expect(prime.retryable).toBe(true);

    // Catalog entries must NOT include implementation-private fields
    const primeAny = prime as Record<string, unknown>;
    expect(primeAny.path).toBeUndefined();
    expect(primeAny.required_env).toBeUndefined();
    expect(primeAny.input_schema).toBeUndefined();
    expect(primeAny.output_schema).toBeUndefined();
    expect(primeAny.rerun_policy).toBeUndefined();
  });

  it("includes orchestrator_notes when present", async () => {
    const manifestPath = await writeManifest(NO_ORCHESTRATOR_NOTES_YAML, [
      "scripts/with_notes.py",
      "scripts/without_notes.js",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const catalog = buildCatalogSummary(registry);
    const withNotes = catalog.find((e) => e.script_id === "with.notes")!;
    const withoutNotes = catalog.find((e) => e.script_id === "without.notes")!;

    expect(withNotes.orchestrator_notes).toBe("These are orchestrator notes");
    expect(withoutNotes.orchestrator_notes).toBeUndefined();
  });

  it("returns empty array for empty registry", () => {
    const emptyRegistry = new Map();
    const catalog = buildCatalogSummary(emptyRegistry);
    expect(catalog).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Group 5: validateEnvRequirements
// -------------------------------------------------------------------

describe("validateEnvRequirements", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.VAR_A = process.env.VAR_A;
    savedEnv.VAR_B = process.env.VAR_B;
    savedEnv.MISSING_VAR = process.env.MISSING_VAR;
    savedEnv.SECRET_KEY = process.env.SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns success when all required env vars are present", async () => {
    process.env.VAR_A = "value_a";
    process.env.VAR_B = "value_b";

    const manifestPath = await writeManifest(ENV_REQUIRED_YAML, [
      "scripts/env_check.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = validateEnvRequirements(registry, "env.check");
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!.missing).toHaveLength(0);
  });

  it("returns descriptive error when required env vars are missing", async () => {
    delete process.env.VAR_A;
    delete process.env.VAR_B;

    const manifestPath = await writeManifest(ENV_REQUIRED_YAML, [
      "scripts/env_check.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = validateEnvRequirements(registry, "env.check");
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.missing).toContain("VAR_A");
    expect(result!.missing).toContain("VAR_B");
  });

  it("does not expose env var values in the result", async () => {
    process.env.SECRET_KEY = "super-secret-value";

    const secretYaml = `
scripts:
  - script_id: secret.check
    description: "Script checking secret env"
    runtime: python
    path: scripts/secret.py
    timeout_ms: 10000
    retryable: false
    side_effects: read-only
    required_env:
      - SECRET_KEY
    rerun_policy: restart
`;
    const manifestPath = await writeManifest(secretYaml, [
      "scripts/secret.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = validateEnvRequirements(registry, "secret.check");
    expect(result).not.toBeNull();

    // The result object must not contain env var values anywhere
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("super-secret-value");
  });

  it("returns null for unknown script ID", async () => {
    const manifestPath = await writeManifest(VALID_SINGLE_SCRIPT_YAML, [
      "scripts/knowledge/prime_knowledge.py",
    ]);
    const registry = await loadScriptRegistry(manifestPath, tempDir);

    const result = validateEnvRequirements(registry, "nonexistent");
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 6: YAML Manifest Integration
// -------------------------------------------------------------------

describe("YAML Manifest Integration", () => {
  it("actual manifest.yaml file parses correctly", async () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const manifestPath = path.join(projectRoot, "scripts", "manifest.yaml");

    const registry = await loadScriptRegistry(manifestPath, projectRoot);
    expect(registry.size).toBeGreaterThanOrEqual(2);
    expect(registry.has("knowledge.prime")).toBe(true);
    expect(registry.has("implementation.batch_bridge")).toBe(true);
  });

  it("manifest.yaml contains both required script entries with correct fields", async () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const manifestPath = path.join(projectRoot, "scripts", "manifest.yaml");

    const registry = await loadScriptRegistry(manifestPath, projectRoot);

    const prime = registry.get("knowledge.prime")!;
    expect(prime.runtime).toBe("python");
    expect(prime.side_effects).toBe("read-only");
    expect(prime.timeout_ms).toBeGreaterThan(0);

    const bridge = registry.get("implementation.batch_bridge")!;
    expect(bridge.runtime).toBe("python");
    expect(bridge.side_effects).toBe("workspace-write");
    expect(bridge.timeout_ms).toBeGreaterThan(0);
  });
});
