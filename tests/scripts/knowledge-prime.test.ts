import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScriptRegistry } from "../../src/scripts/registry.js";
import { parseResultEnvelope } from "../../src/runtime/script-handler.js";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-kp-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// Group 1: Manifest Entry Validation
// -------------------------------------------------------------------

describe("knowledge.prime manifest entry", () => {
  it("entry exists in manifest with all required metadata fields", async () => {
    const manifestPath = path.join(PROJECT_ROOT, "scripts", "manifest.yaml");
    const registry = await loadScriptRegistry(manifestPath, PROJECT_ROOT);

    expect(registry.has("knowledge.prime")).toBe(true);

    const entry = registry.get("knowledge.prime")!;
    expect(entry.runtime).toBe("python");
    expect(entry.side_effects).toBe("read-only");
    expect(entry.required_env).toContain("ANTHROPIC_API_KEY");
    expect(entry.rerun_policy).toBe("restart");
    expect(entry.timeout_ms).toBeGreaterThan(0);
    expect(entry.path).toBe("scripts/knowledge/prime_knowledge.py");
  });

  it("script path resolves to a non-empty file (not just a placeholder comment)", async () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts",
      "knowledge",
      "prime_knowledge.py",
    );
    const fileStat = await stat(scriptPath);
    expect(fileStat.isFile()).toBe(true);

    const content = await readFile(scriptPath, "utf-8");
    // The adapter must be more than a single-line placeholder comment
    const meaningfulLines = content
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
    expect(meaningfulLines.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 2: Adapter Script stdin/stdout Contract
// -------------------------------------------------------------------

describe.skipIf(!uvAvailable)("knowledge.prime adapter stdin/stdout contract", () => {
  it("accepts JSON stdin and produces valid JSON envelope on stdout", () => {
    const stdinPayload = JSON.stringify({
      task_state: { description: "test task", workspace: tempDir },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "knowledge", "prime_knowledge.py")}`,
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

  it("envelope contains outputs with knowledge artifact having path, label, and format", () => {
    const stdinPayload = JSON.stringify({
      task_state: { description: "test task", workspace: tempDir },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "knowledge", "prime_knowledge.py")}`,
      {
        input: stdinPayload,
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      },
    );

    const envelope = JSON.parse(stdout);
    expect(envelope.outputs).toBeDefined();
    expect(envelope.outputs.knowledge_artifact).toBeDefined();
    expect(envelope.outputs.knowledge_artifact.path).toContain("knowledge-context");
    expect(envelope.outputs.knowledge_artifact.label).toBeDefined();
    expect(envelope.outputs.knowledge_artifact.format).toBe("md");
  });

  it("creates compatibility mirror file at .bees/knowledge-context.md", async () => {
    const stdinPayload = JSON.stringify({
      task_state: { description: "test task", workspace: tempDir },
      input_patch: {},
    });

    execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "knowledge", "prime_knowledge.py")}`,
      {
        input: stdinPayload,
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      },
    );

    const mirrorPath = path.join(tempDir, ".bees", "knowledge-context.md");
    const mirrorStat = await stat(mirrorPath);
    expect(mirrorStat.isFile()).toBe(true);

    const content = await readFile(mirrorPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("exits with code 1 on malformed stdin", () => {
    let exitCode = 0;
    let stderr = "";
    try {
      execSync(
        `uv run ${path.join(PROJECT_ROOT, "scripts", "knowledge", "prime_knowledge.py")}`,
        {
          input: "not valid json",
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

    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Group 3: Artifact Registration Compatibility
// -------------------------------------------------------------------

describe.skipIf(!uvAvailable)("knowledge.prime artifact registration", () => {
  it("envelope is parseable by parseResultEnvelope without throwing", () => {
    const stdinPayload = JSON.stringify({
      task_state: { description: "test task", workspace: tempDir },
      input_patch: {},
    });

    const stdout = execSync(
      `uv run ${path.join(PROJECT_ROOT, "scripts", "knowledge", "prime_knowledge.py")}`,
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
