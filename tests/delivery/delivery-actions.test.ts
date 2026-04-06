import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import * as childProcess from "node:child_process";
import path from "node:path";

// ---------------------------------------------------------------
// Logger mock (must use vi.hoisted so the factory can reference mocks)
// ---------------------------------------------------------------

const { mockWarn, mockInfo, mockError, mockDebug } = vi.hoisted(() => {
  return {
    mockWarn: vi.fn(),
    mockInfo: vi.fn(),
    mockError: vi.fn(),
    mockDebug: vi.fn(),
  };
});

// Re-export node:child_process through vi.mock to make exports configurable
// in ESM, enabling vi.spyOn on execFileSync for gh CLI interception tests.
vi.mock("node:child_process", async (importOriginal) => {
  return { ...(await importOriginal<typeof import("node:child_process")>()) };
});

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  }),
  logger: {
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  },
}));

// ---------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------

import {
  stageExplicit,
  isExcludedPath,
} from "../../src/delivery/stage-explicit.js";

import type { BeesUser } from "../../src/delivery/bees-user.js";

/**
 * Lazily import commit-with-trailers module. Uses dynamic import so that
 * a missing module only breaks commit-specific tests, not the entire file.
 */
async function loadCommitModule(): Promise<{
  commitWithTrailers: typeof import("../../src/delivery/commit-with-trailers.js").commitWithTrailers;
  buildCommitMessage: typeof import("../../src/delivery/commit-with-trailers.js").buildCommitMessage;
}> {
  return await import("../../src/delivery/commit-with-trailers.js");
}

/**
 * Lazily import push-branch module. Uses dynamic import so that
 * a missing module only breaks push-specific tests, not the entire file.
 */
async function loadPushModule(): Promise<{
  pushBranch: typeof import("../../src/delivery/push-branch.js").pushBranch;
}> {
  return await import("../../src/delivery/push-branch.js");
}

/**
 * Lazily import upsert-draft-pr module. Uses dynamic import so that
 * a missing module only breaks PR-specific tests, not the entire file.
 */
async function loadUpsertPrModule(): Promise<{
  upsertDraftPr: typeof import("../../src/delivery/upsert-draft-pr.js").upsertDraftPr;
}> {
  return await import("../../src/delivery/upsert-draft-pr.js");
}

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

/**
 * Create a temporary git repository with an initial commit on main.
 * Configures identity and creates an empty initial commit so that
 * git add and git diff commands work correctly.
 */
async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bees-stage-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git checkout -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Write a file at a relative path inside a repository directory.
 * Creates parent directories as needed.
 */
async function writeFileInRepo(
  repoDir: string,
  relativePath: string,
  content = "// placeholder",
): Promise<void> {
  const fullPath = path.join(repoDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * Get the list of staged file names from a git repository.
 */
function getStagedFiles(repoDir: string): string[] {
  const output = execSync("git diff --cached --name-only", {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
  return output.length === 0 ? [] : output.split("\n");
}

// ---------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------

let tempDir: string;

// ---------------------------------------------------------------
// Group 1: Exclusion Filter Logic (Unit Tests)
// ---------------------------------------------------------------

describe("stageExplicit -- Exclusion Filter Logic", () => {
  it("filters files matching .bees/ directory", () => {
    const paths = [".bees/config.yaml", ".bees/state.json", "src/index.ts"];

    const beesConfig = isExcludedPath(".bees/config.yaml");
    const beesState = isExcludedPath(".bees/state.json");
    const srcIndex = isExcludedPath("src/index.ts");

    expect(beesConfig.excluded).toBe(true);
    expect(beesConfig.reason).toBeDefined();
    expect(beesState.excluded).toBe(true);
    expect(srcIndex.excluded).toBe(false);
  });

  it("filters files matching node_modules/ directory", () => {
    const nodeFile = isExcludedPath("node_modules/pkg/index.js");
    const srcFile = isExcludedPath("src/app.ts");

    expect(nodeFile.excluded).toBe(true);
    expect(nodeFile.reason).toBeDefined();
    expect(srcFile.excluded).toBe(false);
  });

  it("filters files matching runtime/ directory", () => {
    const runtimeFile = isExcludedPath("runtime/runs/task.json");
    const helperFile = isExcludedPath("src/utils/helper.ts");

    expect(runtimeFile.excluded).toBe(true);
    expect(runtimeFile.reason).toBeDefined();
    expect(helperFile.excluded).toBe(false);
  });

  it("filters files matching .env* pattern", () => {
    const env = isExcludedPath(".env");
    const envLocal = isExcludedPath(".env.local");
    const envProd = isExcludedPath(".env.production");
    const configTs = isExcludedPath("src/config.ts");

    expect(env.excluded).toBe(true);
    expect(envLocal.excluded).toBe(true);
    expect(envProd.excluded).toBe(true);
    expect(configTs.excluded).toBe(false);
  });

  it("applies all exclusion rules simultaneously", () => {
    const paths = [
      ".bees/config.yaml",
      "node_modules/pkg/index.js",
      "runtime/runs/task.json",
      ".env.local",
      "src/index.ts",
      "README.md",
    ];

    const results = paths.map((p) => ({ path: p, ...isExcludedPath(p) }));
    const excluded = results.filter((r) => r.excluded);
    const passed = results.filter((r) => !r.excluded);

    expect(excluded.length).toBe(4);
    expect(passed.length).toBe(2);
  });

  it("passes files that do not match any exclusion", () => {
    const paths = ["src/index.ts", "tests/foo.test.ts", "README.md"];

    for (const p of paths) {
      const result = isExcludedPath(p);
      expect(result.excluded).toBe(false);
    }
  });
});

// ---------------------------------------------------------------
// Group 2: Input Validation (Unit Tests)
// ---------------------------------------------------------------

describe("stageExplicit -- Input Validation", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "bees-stage-val-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty result for empty file list", async () => {
    const result = await stageExplicit({
      files: [],
      workspacePath: tempDir,
    });

    expect(result.outputs.staged).toEqual([]);
    expect(result.outputs.excluded).toEqual([]);
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe("string");
  });

  it("validates workspacePath is provided", async () => {
    const result = await stageExplicit({
      files: ["src/index.ts"],
      workspacePath: "",
    });

    // Empty workspacePath should produce an error result
    expect(result.summary).toMatch(/error|invalid|missing/i);
  });
});

// ---------------------------------------------------------------
// Group 3: Result Envelope Structure (Unit Tests)
// ---------------------------------------------------------------

describe("stageExplicit -- Result Envelope Structure", () => {
  beforeEach(async () => {
    tempDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("result has required summary field", async () => {
    await writeFileInRepo(tempDir, "src/index.ts");

    const result = await stageExplicit({
      files: ["src/index.ts"],
      workspacePath: tempDir,
    });

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("result outputs contain staged and excluded arrays", async () => {
    await writeFileInRepo(tempDir, "src/app.ts");
    await writeFileInRepo(tempDir, ".bees/state.json");

    const result = await stageExplicit({
      files: ["src/app.ts", ".bees/state.json"],
      workspacePath: tempDir,
    });

    expect(Array.isArray(result.outputs.staged)).toBe(true);
    expect(Array.isArray(result.outputs.excluded)).toBe(true);
  });
});

// ---------------------------------------------------------------
// Group 4: Git Integration (Integration Tests)
// ---------------------------------------------------------------

describe("stageExplicit -- Git Integration", () => {
  beforeEach(async () => {
    tempDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stages specific files via git add in a real temp repo", async () => {
    await writeFileInRepo(tempDir, "src/a.ts");
    await writeFileInRepo(tempDir, "src/b.ts");

    const result = await stageExplicit({
      files: ["src/a.ts", "src/b.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("src/a.ts");
    expect(staged).toContain("src/b.ts");
    expect(result.outputs.staged).toContain("src/a.ts");
    expect(result.outputs.staged).toContain("src/b.ts");
  });

  it("excludes .bees/ directory files in a real workspace", async () => {
    await writeFileInRepo(tempDir, ".bees/state.json");
    await writeFileInRepo(tempDir, "src/index.ts");

    const result = await stageExplicit({
      files: [".bees/state.json", "src/index.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("src/index.ts");
    expect(staged).not.toContain(".bees/state.json");

    const excludedPaths = result.outputs.excluded.map(
      (e: { path: string }) => e.path,
    );
    expect(excludedPaths).toContain(".bees/state.json");
  });

  it("excludes node_modules/ files in a real workspace", async () => {
    await writeFileInRepo(tempDir, "node_modules/pkg/index.js");
    await writeFileInRepo(tempDir, "src/app.ts");

    const result = await stageExplicit({
      files: ["node_modules/pkg/index.js", "src/app.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("src/app.ts");
    expect(staged).not.toContain("node_modules/pkg/index.js");
  });

  it("excludes .env files in a real workspace", async () => {
    await writeFileInRepo(tempDir, ".env", "SECRET=abc");
    await writeFileInRepo(tempDir, ".env.local", "LOCAL_SECRET=xyz");
    await writeFileInRepo(tempDir, "config.ts");

    const result = await stageExplicit({
      files: [".env", ".env.local", "config.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("config.ts");
    expect(staged).not.toContain(".env");
    expect(staged).not.toContain(".env.local");
  });

  it("reports non-existent files as excluded with reason", async () => {
    await writeFileInRepo(tempDir, "src/real.ts");

    const result = await stageExplicit({
      files: ["does-not-exist.ts", "src/real.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("src/real.ts");

    const excludedPaths = result.outputs.excluded.map(
      (e: { path: string }) => e.path,
    );
    expect(excludedPaths).toContain("does-not-exist.ts");

    const nonExistentEntry = result.outputs.excluded.find(
      (e: { path: string; reason: string }) => e.path === "does-not-exist.ts",
    );
    expect(nonExistentEntry).toBeDefined();
    expect(nonExistentEntry!.reason).toMatch(/not exist|not found|missing/i);
  });

  it("does not perform broad git add (no -A or .)", async () => {
    await writeFileInRepo(tempDir, "a.ts");
    await writeFileInRepo(tempDir, "b.ts");
    await writeFileInRepo(tempDir, "c.ts");

    const result = await stageExplicit({
      files: ["a.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toEqual(["a.ts"]);
    expect(staged).not.toContain("b.ts");
    expect(staged).not.toContain("c.ts");
  });

  it("handles glob patterns to match files", async () => {
    await writeFileInRepo(tempDir, "src/a.ts");
    await writeFileInRepo(tempDir, "src/b.ts");
    await writeFileInRepo(tempDir, "tests/c.ts");

    const result = await stageExplicit({
      files: ["src/*.ts"],
      workspacePath: tempDir,
    });

    const staged = getStagedFiles(tempDir);
    expect(staged).toContain("src/a.ts");
    expect(staged).toContain("src/b.ts");
    expect(staged).not.toContain("tests/c.ts");

    expect(result.outputs.staged).toContain("src/a.ts");
    expect(result.outputs.staged).toContain("src/b.ts");
  });
});

// ---------------------------------------------------------------
// Commit-with-trailers test helpers
// ---------------------------------------------------------------

/**
 * Build a Map of BeesUser entries keyed by slackUserId for test convenience.
 */
function createBeesUserMap(users: BeesUser[]): Map<string, BeesUser> {
  const map = new Map<string, BeesUser>();
  for (const user of users) {
    map.set(user.slackUserId, user);
  }
  return map;
}

/**
 * Write a file and stage it in one call. Creates parent directories as needed.
 */
async function stageFileInRepo(
  repoDir: string,
  relativePath: string,
  content = "// staged content",
): Promise<void> {
  await writeFileInRepo(repoDir, relativePath, content);
  execSync(`git add ${relativePath}`, { cwd: repoDir, stdio: "pipe" });
}

/**
 * Read the full commit message from the last commit in the repo.
 */
function getLastCommitMessage(repoDir: string): string {
  return execSync("git log -1 --format=%B", {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Read the full SHA of the last commit in the repo.
 */
function getLastCommitSha(repoDir: string): string {
  return execSync("git log -1 --format=%H", {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Create a temporary bare git repository that simulates a remote.
 * Returns the absolute path to the bare repo directory.
 */
async function createBareRemoteRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bees-bare-remote-"));
  execSync("git init --bare", { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Add a remote pointing to a local bare repo path.
 * Defaults the remote name to "origin".
 */
function addRemoteToRepo(
  repoDir: string,
  remotePath: string,
  remoteName = "origin",
): void {
  execSync(`git remote add ${remoteName} ${remotePath}`, {
    cwd: repoDir,
    stdio: "pipe",
  });
}

/**
 * List branch names present in a bare repository.
 * Returns an array of trimmed branch names (without the leading "* ").
 */
function getRemoteBranches(bareRepoPath: string): string[] {
  try {
    const output = execSync("git branch", {
      cwd: bareRepoPath,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    if (output.length === 0) return [];
    return output.split("\n").map((b) => b.replace(/^\*?\s*/, "").trim());
  } catch {
    return [];
  }
}

/**
 * Read the committer identity (name and email) from the last commit.
 */
function getCommitterIdentity(repoDir: string): { name: string; email: string } {
  const output = execSync("git log -1 --format=%cn%n%ce", {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
  const [name, email] = output.split("\n");
  return { name, email };
}

// ---------------------------------------------------------------
// Commit-with-trailers test data
// ---------------------------------------------------------------

const FULL_USER: BeesUser = {
  slackUserId: "U001",
  slackDisplayName: "alice",
  githubName: "Alice Smith",
  githubEmail: "alice@example.com",
};

const PARTIAL_USER: BeesUser = {
  slackUserId: "U002",
  slackDisplayName: "bob",
  githubName: "Bob",
};

const MINIMAL_USER: BeesUser = {
  slackUserId: "U003",
  slackDisplayName: "charlie",
};

// ---------------------------------------------------------------
// Group 5: Commit Message Building (Unit Tests)
// ---------------------------------------------------------------

describe("commitWithTrailers -- Commit Message Building", () => {
  it("builds conventional message with type and scope", async () => {
    const { buildCommitMessage } = await loadCommitModule();
    const result = buildCommitMessage("add user endpoint", "feat", "api");
    expect(result).toBe("feat(api): add user endpoint");
  });

  it("builds conventional message with type only (no scope)", async () => {
    const { buildCommitMessage } = await loadCommitModule();
    const result = buildCommitMessage("fix typo in readme", "docs");
    expect(result).toBe("docs: fix typo in readme");
  });

  it("builds conventional message with empty scope", async () => {
    const { buildCommitMessage } = await loadCommitModule();
    const result = buildCommitMessage("clean up", "chore", "");
    expect(result).toBe("chore: clean up");
  });
});

// ---------------------------------------------------------------
// Group 6: Trailer Assembly (Unit Tests)
// ---------------------------------------------------------------

describe("commitWithTrailers -- Trailer Assembly", () => {
  let commitTempDir: string;

  beforeEach(async () => {
    commitTempDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await rm(commitTempDir, { recursive: true, force: true });
  });

  it("assembles trailers for user with full GitHub identity", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(commitTempDir, "src/a.ts");

    const result = await commitWithTrailers(
      {
        message: "add endpoint",
        type: "feat",
        scope: "api",
        requestedBy: "U001",
        workspacePath: commitTempDir,
      },
      users,
    );

    expect(result.outputs.fullMessage).toContain("Requested-by: Alice Smith");
    expect(result.outputs.fullMessage).toContain(
      "Co-authored-by: Alice Smith <alice@example.com>",
    );
  });

  it("assembles trailers for user with partial GitHub identity (name only)", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([PARTIAL_USER]);
    await stageFileInRepo(commitTempDir, "src/b.ts");

    const result = await commitWithTrailers(
      {
        message: "fix bug",
        type: "fix",
        requestedBy: "U002",
        workspacePath: commitTempDir,
      },
      users,
    );

    expect(result.outputs.fullMessage).toContain("Requested-by: Bob");
    expect(result.outputs.fullMessage).not.toContain("Co-authored-by:");
  });

  it("assembles trailers for user with no GitHub identity", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([MINIMAL_USER]);
    await stageFileInRepo(commitTempDir, "src/c.ts");

    const result = await commitWithTrailers(
      {
        message: "update config",
        type: "chore",
        requestedBy: "U003",
        workspacePath: commitTempDir,
      },
      users,
    );

    expect(result.outputs.fullMessage).toContain("Requested-by: charlie");
    expect(result.outputs.fullMessage).not.toContain("Co-authored-by:");
  });

  it("handles null user (unmapped Slack ID) gracefully", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([]);
    await stageFileInRepo(commitTempDir, "src/d.ts");

    const result = await commitWithTrailers(
      {
        message: "quick fix",
        type: "fix",
        requestedBy: "U999",
        workspacePath: commitTempDir,
      },
      users,
    );

    expect(result.outputs.fullMessage).toContain("Requested-by: U999");
    expect(result.outputs.fullMessage).not.toContain("Co-authored-by:");
  });
});

// ---------------------------------------------------------------
// Group 7: Full Message Assembly (Unit Tests)
// ---------------------------------------------------------------

describe("commitWithTrailers -- Full Message Assembly", () => {
  let msgTempDir: string;

  beforeEach(async () => {
    msgTempDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await rm(msgTempDir, { recursive: true, force: true });
  });

  it("combines subject line with trailers separated by blank line", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(msgTempDir, "src/widget.ts");

    const result = await commitWithTrailers(
      {
        message: "add endpoint",
        type: "feat",
        scope: "api",
        requestedBy: "U001",
        workspacePath: msgTempDir,
      },
      users,
    );

    const msg = result.outputs.fullMessage;
    const parts = msg.split("\n\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]).toBe("feat(api): add endpoint");
    expect(parts[1]).toContain("Requested-by:");
  });

  it("full message with no Co-authored-by has single trailer", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([MINIMAL_USER]);
    await stageFileInRepo(msgTempDir, "src/file.ts");

    const result = await commitWithTrailers(
      {
        message: "typo",
        type: "fix",
        requestedBy: "U003",
        workspacePath: msgTempDir,
      },
      users,
    );

    const msg = result.outputs.fullMessage;
    const trailerSection = msg.split("\n\n").slice(1).join("\n\n");
    const trailerLines = trailerSection
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(trailerLines).toHaveLength(1);
    expect(trailerLines[0]).toContain("Requested-by: charlie");
  });
});

// ---------------------------------------------------------------
// Group 8: Staged Changes Detection (Unit Tests with Git)
// ---------------------------------------------------------------

describe("commitWithTrailers -- Staged Changes Detection", () => {
  let stageTempDir: string;

  beforeEach(async () => {
    stageTempDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await rm(stageTempDir, { recursive: true, force: true });
  });

  it("detects no staged changes and returns error", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);

    const result = await commitWithTrailers(
      {
        message: "should fail",
        type: "feat",
        requestedBy: "U001",
        workspacePath: stageTempDir,
      },
      users,
    );

    expect(result.summary).toMatch(/no staged changes/i);
    expect(result.outputs).not.toHaveProperty("commitSha");
  });

  it("detects staged changes when files are staged", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(stageTempDir, "src/index.ts");

    const result = await commitWithTrailers(
      {
        message: "add index",
        type: "feat",
        requestedBy: "U001",
        workspacePath: stageTempDir,
      },
      users,
    );

    expect(result.outputs.commitSha).toBeDefined();
    expect(result.outputs.commitSha.length).toBe(40);
  });
});

// ---------------------------------------------------------------
// Group 9: Git Commit Integration (Integration Tests)
// ---------------------------------------------------------------

describe("commitWithTrailers -- Git Commit Integration", () => {
  let integTempDir: string;

  beforeEach(async () => {
    integTempDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    await rm(integTempDir, { recursive: true, force: true });
  });

  it("creates a real commit with conventional message and trailers", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(integTempDir, "src/widget.ts");

    const result = await commitWithTrailers(
      {
        message: "add widget",
        type: "feat",
        scope: "ui",
        requestedBy: "U001",
        workspacePath: integTempDir,
      },
      users,
    );

    const gitMessage = getLastCommitMessage(integTempDir);
    expect(gitMessage).toContain("feat(ui): add widget");
    expect(gitMessage).toContain("Requested-by:");
    expect(gitMessage).toContain("Co-authored-by:");

    const gitSha = getLastCommitSha(integTempDir);
    expect(gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.outputs.commitSha).toBe(gitSha);
  });

  it("commit has bees-bot committer identity", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(integTempDir, "src/identity.ts");

    await commitWithTrailers(
      {
        message: "verify identity",
        type: "test",
        requestedBy: "U001",
        workspacePath: integTempDir,
      },
      users,
    );

    const identity = getCommitterIdentity(integTempDir);
    expect(identity.name).toBe("bees-bot");
    expect(identity.email).toBe("bees@t-labs.dev");
  });

  it("result envelope contains commitSha and fullMessage", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(integTempDir, "src/envelope.ts");

    const result = await commitWithTrailers(
      {
        message: "check envelope",
        type: "feat",
        requestedBy: "U001",
        workspacePath: integTempDir,
      },
      users,
    );

    expect(result.outputs.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.outputs.fullMessage).toContain("feat: check envelope");
    expect(result.state_patch).toBeDefined();
    expect(result.state_patch?.lastCommitSha).toBe(result.outputs.commitSha);
  });

  it("commit without scope omits parentheses in log", async () => {
    const { commitWithTrailers } = await loadCommitModule();
    const users = createBeesUserMap([FULL_USER]);
    await stageFileInRepo(integTempDir, "README.md", "# Updated readme");

    await commitWithTrailers(
      {
        message: "update readme",
        type: "docs",
        requestedBy: "U001",
        workspacePath: integTempDir,
      },
      users,
    );

    const subject = execSync("git log -1 --format=%s", {
      cwd: integTempDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    expect(subject).toBe("docs: update readme");
    expect(subject).not.toContain("(");
    expect(subject).not.toContain(")");
  });
});

// ---------------------------------------------------------------
// Group 10: pushBranch -- Input Validation (Unit Tests)
// ---------------------------------------------------------------

describe("pushBranch -- Input Validation", () => {
  let pushTempDir: string;

  beforeEach(async () => {
    pushTempDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    await rm(pushTempDir, { recursive: true, force: true });
  });

  it("missing branchName returns error result", async () => {
    const { pushBranch } = await loadPushModule();

    const result = await pushBranch({
      branchName: "",
      workspacePath: pushTempDir,
    });

    expect(result.summary).toMatch(/error|missing|invalid/i);
    expect(result.outputs).not.toHaveProperty("pushed", true);
  });

  it("missing workspacePath returns error result", async () => {
    const { pushBranch } = await loadPushModule();

    const result = await pushBranch({
      branchName: "bees/task-001-test",
      workspacePath: "",
    });

    expect(result.summary).toMatch(/error|missing/i);
    expect(result.outputs).not.toHaveProperty("pushed", true);
  });
});

// ---------------------------------------------------------------
// Group 11: pushBranch -- GITHUB_TOKEN Validation (Unit Tests)
// ---------------------------------------------------------------

describe("pushBranch -- GITHUB_TOKEN Validation", () => {
  let tokenTempDir: string;
  let bareRemotePath: string;

  beforeEach(async () => {
    tokenTempDir = await createTempGitRepo();
    bareRemotePath = await createBareRemoteRepo();
    addRemoteToRepo(tokenTempDir, bareRemotePath);
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tokenTempDir, { recursive: true, force: true });
    await rm(bareRemotePath, { recursive: true, force: true });
  });

  it("missing GITHUB_TOKEN fails with clear error before any git operation", async () => {
    delete process.env.GITHUB_TOKEN;
    const { pushBranch } = await loadPushModule();

    const result = await pushBranch({
      branchName: "main",
      workspacePath: tokenTempDir,
    });

    expect(result.summary).toMatch(/GITHUB_TOKEN/i);
    expect(result.outputs).not.toHaveProperty("pushed", true);
  });

  it("GITHUB_TOKEN presence check passes when env var is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test123");
    const { pushBranch } = await loadPushModule();

    const result = await pushBranch({
      branchName: "main",
      workspacePath: tokenTempDir,
    });

    // Should not fail on the token check (may fail or succeed on push,
    // but must NOT contain a GITHUB_TOKEN-missing error)
    expect(result.summary).not.toMatch(/GITHUB_TOKEN.*missing/i);
  });

  it("token value never appears in error messages", async () => {
    const secretToken = "ghp_SuperSecretValue12345";
    vi.stubEnv("GITHUB_TOKEN", secretToken);
    const { pushBranch } = await loadPushModule();

    // Use a non-existent workspace to force an error path
    const result = await pushBranch({
      branchName: "nonexistent-branch",
      workspacePath: "/tmp/does-not-exist-bees-test",
    });

    expect(result.summary).not.toContain(secretToken);

    // Verify logger calls do not contain the token value
    for (const mock of [mockError, mockWarn, mockInfo, mockDebug]) {
      for (const call of mock.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(secretToken);
      }
    }
  });

  it("token value never appears in logger output", async () => {
    const secretToken = "ghp_AnotherSecretToken99";
    vi.stubEnv("GITHUB_TOKEN", secretToken);
    const { pushBranch } = await loadPushModule();

    // Push to local bare remote (should succeed)
    await stageFileInRepo(tokenTempDir, "src/push-test.ts", "// push test");
    execSync('git commit -m "test commit for push"', {
      cwd: tokenTempDir,
      stdio: "pipe",
    });

    await pushBranch({
      branchName: "main",
      workspacePath: tokenTempDir,
    });

    // Verify no logger mock received the token value in any argument
    for (const mock of [mockInfo, mockError, mockWarn, mockDebug]) {
      for (const call of mock.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(secretToken);
      }
    }
  });
});

// ---------------------------------------------------------------
// Group 12: pushBranch -- Result Envelope Structure (Unit Tests)
// ---------------------------------------------------------------

describe("pushBranch -- Result Envelope Structure", () => {
  let envelopeTempDir: string;
  let envelopeBareRemote: string;

  beforeEach(async () => {
    envelopeTempDir = await createTempGitRepo();
    envelopeBareRemote = await createBareRemoteRepo();
    addRemoteToRepo(envelopeTempDir, envelopeBareRemote);
    vi.stubEnv("GITHUB_TOKEN", "ghp_envelopetest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(envelopeTempDir, { recursive: true, force: true });
    await rm(envelopeBareRemote, { recursive: true, force: true });
  });

  it("successful push returns correct result envelope shape", async () => {
    const { pushBranch } = await loadPushModule();

    await stageFileInRepo(envelopeTempDir, "src/envelope.ts", "// envelope");
    execSync('git commit -m "envelope test commit"', {
      cwd: envelopeTempDir,
      stdio: "pipe",
    });

    const result = await pushBranch({
      branchName: "main",
      workspacePath: envelopeTempDir,
    });

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.outputs.remoteBranch).toEqual(expect.any(String));
    expect(result.outputs.remoteBranch).toContain("main");
    expect(result.outputs.pushed).toBe(true);
    expect(result.state_patch).toBeDefined();
    expect(result.state_patch?.deliveryStatus?.push).toBe("completed");
  });
});

// ---------------------------------------------------------------
// Group 13: pushBranch -- Git Push Integration (Integration Tests)
// ---------------------------------------------------------------

describe("pushBranch -- Git Push Integration", () => {
  let integPushDir: string;
  let integBareRemote: string;

  beforeEach(async () => {
    integPushDir = await createTempGitRepo();
    integBareRemote = await createBareRemoteRepo();
    addRemoteToRepo(integPushDir, integBareRemote);
    vi.stubEnv("GITHUB_TOKEN", "ghp_integtest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(integPushDir, { recursive: true, force: true });
    await rm(integBareRemote, { recursive: true, force: true });
  });

  it("pushes branch to local bare remote successfully", async () => {
    const { pushBranch } = await loadPushModule();

    await stageFileInRepo(integPushDir, "src/feature.ts", "// feature");
    execSync('git commit -m "feature commit"', {
      cwd: integPushDir,
      stdio: "pipe",
    });

    const result = await pushBranch({
      branchName: "main",
      workspacePath: integPushDir,
    });

    expect(result.outputs.pushed).toBe(true);
    expect(result.outputs.remoteBranch).toContain("main");

    // Verify branch exists in the bare remote
    const remoteBranches = getRemoteBranches(integBareRemote);
    expect(remoteBranches).toContain("main");
  });

  it("repeated push does not fail (idempotent)", async () => {
    const { pushBranch } = await loadPushModule();

    await stageFileInRepo(integPushDir, "src/idempotent.ts", "// first");
    execSync('git commit -m "first push"', {
      cwd: integPushDir,
      stdio: "pipe",
    });

    const firstResult = await pushBranch({
      branchName: "main",
      workspacePath: integPushDir,
    });
    expect(firstResult.outputs.pushed).toBe(true);

    // Push again without any changes -- must not fail
    const secondResult = await pushBranch({
      branchName: "main",
      workspacePath: integPushDir,
    });
    expect(secondResult.outputs.pushed).toBe(true);
  });

  it("repeated push after additional commit updates remote", async () => {
    const { pushBranch } = await loadPushModule();

    // First commit and push
    await stageFileInRepo(integPushDir, "src/v1.ts", "// version 1");
    execSync('git commit -m "v1"', { cwd: integPushDir, stdio: "pipe" });

    const firstResult = await pushBranch({
      branchName: "main",
      workspacePath: integPushDir,
    });
    expect(firstResult.outputs.pushed).toBe(true);

    // Second commit and push
    await stageFileInRepo(integPushDir, "src/v2.ts", "// version 2");
    execSync('git commit -m "v2"', { cwd: integPushDir, stdio: "pipe" });

    const secondResult = await pushBranch({
      branchName: "main",
      workspacePath: integPushDir,
    });
    expect(secondResult.outputs.pushed).toBe(true);

    // Verify the bare remote has the latest commit
    const localHead = execSync("git rev-parse HEAD", {
      cwd: integPushDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    const remoteHead = execSync("git rev-parse main", {
      cwd: integBareRemote,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    expect(remoteHead).toBe(localHead);
  });

  it("push to non-existent remote fails with descriptive error", async () => {
    const { pushBranch } = await loadPushModule();

    // Create a repo with NO remote configured
    const noRemoteDir = await createTempGitRepo();
    // Remove default origin if any
    try {
      execSync("git remote remove origin", { cwd: noRemoteDir, stdio: "pipe" });
    } catch {
      // origin might not exist, that is fine
    }

    await stageFileInRepo(noRemoteDir, "src/orphan.ts", "// orphan");
    execSync('git commit -m "orphan commit"', {
      cwd: noRemoteDir,
      stdio: "pipe",
    });

    const result = await pushBranch({
      branchName: "main",
      workspacePath: noRemoteDir,
    });

    expect(result.summary).toMatch(/error|failed|remote/i);
    expect(result.outputs).not.toHaveProperty("pushed", true);

    await rm(noRemoteDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------
// upsertDraftPr test helpers
// ---------------------------------------------------------------

/**
 * Type alias for the execFileSync spy mock implementation callback.
 * Maps gh subcommand patterns to mock responses.
 */
type GhMockResponses = {
  prList?: string | Error;
  prCreate?: string | Error;
  prEdit?: string | Error;
};

/**
 * Original execFileSync reference captured before spy installation.
 * Used by the conditional mock to pass through non-gh calls.
 */
const originalExecFileSync = childProcess.execFileSync;

/**
 * Install a spy on execFileSync that intercepts gh CLI calls and
 * passes through git calls to the real implementation.
 *
 * @param responses - Mock responses keyed by gh subcommand
 * @returns The installed spy for assertion and cleanup
 */
function installGhMock(responses: GhMockResponses) {
  return vi.spyOn(childProcess, "execFileSync").mockImplementation(
    ((cmd: string, args?: readonly string[], options?: Record<string, unknown>) => {
      if (cmd === "gh") {
        const argsArr = args ?? [];
        const joined = argsArr.join(" ");

        // gh pr list
        if (joined.includes("pr") && joined.includes("list")) {
          if (responses.prList instanceof Error) throw responses.prList;
          return responses.prList ?? "[]";
        }

        // gh pr create
        if (joined.includes("pr") && joined.includes("create")) {
          if (responses.prCreate instanceof Error) throw responses.prCreate;
          return responses.prCreate ?? "https://github.com/org/repo/pull/99";
        }

        // gh pr edit
        if (joined.includes("pr") && joined.includes("edit")) {
          if (responses.prEdit instanceof Error) throw responses.prEdit;
          return responses.prEdit ?? "";
        }

        return "";
      }

      // Pass through git and other commands to real implementation
      return originalExecFileSync(cmd, args as string[], options as Record<string, unknown>);
    }) as typeof childProcess.execFileSync,
  );
}

// ---------------------------------------------------------------
// Group 14: upsertDraftPr -- Input Validation (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- Input Validation", () => {
  let prTempDir: string;

  beforeEach(async () => {
    prTempDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(prTempDir, { recursive: true, force: true });
  });

  it("missing title returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();

    const result = await upsertDraftPr({
      title: "",
      body: "description",
      branchName: "bees/t-1",
      workspacePath: prTempDir,
    });

    expect(result.summary).toMatch(/error|missing/i);
    expect(result.outputs).not.toHaveProperty("prUrl");
  });

  it("missing branchName returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();

    const result = await upsertDraftPr({
      title: "PR Title",
      body: "description",
      branchName: "",
      workspacePath: prTempDir,
    });

    expect(result.summary).toMatch(/error|missing/i);
    expect(result.outputs).not.toHaveProperty("prUrl");
  });

  it("missing workspacePath returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();

    const result = await upsertDraftPr({
      title: "PR Title",
      body: "description",
      branchName: "bees/t-1",
      workspacePath: "",
    });

    expect(result.summary).toMatch(/error|missing/i);
    expect(result.outputs).not.toHaveProperty("prUrl");
  });
});

// ---------------------------------------------------------------
// Group 15: upsertDraftPr -- GITHUB_TOKEN Validation (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- GITHUB_TOKEN Validation", () => {
  let tokenPrDir: string;

  beforeEach(async () => {
    tokenPrDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tokenPrDir, { recursive: true, force: true });
  });

  it("missing GITHUB_TOKEN fails with clear error before any gh operation", async () => {
    delete process.env.GITHUB_TOKEN;
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({ prList: "[]" });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-1",
        workspacePath: tokenPrDir,
      });

      expect(result.summary).toMatch(/GITHUB_TOKEN/i);
      expect(result.outputs).not.toHaveProperty("prUrl");

      // Verify gh was never called
      const ghCalls = spy.mock.calls.filter(
        (call) => call[0] === "gh",
      );
      expect(ghCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("GITHUB_TOKEN presence check passes when env var is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test123");
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/99",
    });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-1",
        workspacePath: tokenPrDir,
      });

      // Must not fail with GITHUB_TOKEN error
      expect(result.summary).not.toMatch(/GITHUB_TOKEN.*missing/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------
// Group 16: upsertDraftPr -- Result Envelope Structure (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- Result Envelope Structure", () => {
  let envelopePrDir: string;

  beforeEach(async () => {
    envelopePrDir = await createTempGitRepo();
    vi.stubEnv("GITHUB_TOKEN", "ghp_envelopetest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(envelopePrDir, { recursive: true, force: true });
  });

  it("successful create returns correct result envelope shape", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/99",
    });

    try {
      const result = await upsertDraftPr({
        title: "New Feature PR",
        body: "Description of changes",
        branchName: "bees/task-001-feature",
        workspacePath: envelopePrDir,
      });

      // Summary
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);

      // Outputs
      expect(result.outputs.prUrl).toEqual(expect.any(String));
      expect(result.outputs.prUrl).toContain("github.com");
      expect(result.outputs.prNumber).toEqual(expect.any(Number));
      expect(result.outputs.prNumber).toBe(99);
      expect(result.outputs.action).toBe("created");

      // State patch
      expect(result.state_patch).toBeDefined();
      expect(result.state_patch?.prUrl).toBe(result.outputs.prUrl);
      expect(result.state_patch?.prNumber).toBe(result.outputs.prNumber);
      expect(result.state_patch?.prAction).toBe("created");
      expect(result.state_patch?.deliveryStatus?.pr).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });

  it("successful update returns correct result envelope shape", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: '[{"number":42,"url":"https://github.com/org/repo/pull/42"}]',
      prEdit: "",
    });

    try {
      const result = await upsertDraftPr({
        title: "Updated Feature PR",
        body: "Updated description",
        branchName: "bees/task-001-feature",
        workspacePath: envelopePrDir,
      });

      expect(result.outputs.action).toBe("updated");
      expect(result.outputs.prNumber).toBe(42);
      expect(result.outputs.prUrl).toContain("pull/42");
      expect(result.state_patch?.prAction).toBe("updated");
      expect(result.state_patch?.deliveryStatus?.pr).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------
// Group 17: upsertDraftPr -- PR Deduplication Logic (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- PR Deduplication Logic", () => {
  let dedupPrDir: string;

  beforeEach(async () => {
    dedupPrDir = await createTempGitRepo();
    vi.stubEnv("GITHUB_TOKEN", "ghp_deduptest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dedupPrDir, { recursive: true, force: true });
  });

  it("detects existing open PR by branch name and updates instead of creating", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: '[{"number":42,"url":"https://github.com/org/repo/pull/42"}]',
      prEdit: "",
    });

    try {
      const result = await upsertDraftPr({
        title: "Updated Title",
        body: "Updated body",
        branchName: "bees/task-001-feature",
        workspacePath: dedupPrDir,
      });

      expect(result.outputs.action).toBe("updated");
      expect(result.outputs.prNumber).toBe(42);

      // Verify gh pr create was NOT called (only pr list and pr edit)
      const createCalls = spy.mock.calls.filter(
        (call) =>
          call[0] === "gh" &&
          (call[1] as string[])?.join(" ").includes("create"),
      );
      expect(createCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("creates new PR when no existing PR found", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/55",
    });

    try {
      const result = await upsertDraftPr({
        title: "New PR",
        body: "New body",
        branchName: "bees/task-002-new",
        workspacePath: dedupPrDir,
      });

      expect(result.outputs.action).toBe("created");

      // Verify gh pr edit was NOT called (only pr list and pr create)
      const editCalls = spy.mock.calls.filter(
        (call) =>
          call[0] === "gh" &&
          (call[1] as string[])?.join(" ").includes("edit"),
      );
      expect(editCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("idempotent upsert: two calls produce same PR number", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();

    // First call: no existing PR, create returns PR #77
    const spy1 = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/77",
    });

    let firstResult;
    try {
      firstResult = await upsertDraftPr({
        title: "Idempotent PR",
        body: "body text",
        branchName: "bees/task-003-idem",
        workspacePath: dedupPrDir,
      });
    } finally {
      spy1.mockRestore();
    }

    // Second call: existing PR found, update succeeds
    const spy2 = installGhMock({
      prList: '[{"number":77,"url":"https://github.com/org/repo/pull/77"}]',
      prEdit: "",
    });

    let secondResult;
    try {
      secondResult = await upsertDraftPr({
        title: "Idempotent PR Updated",
        body: "updated body",
        branchName: "bees/task-003-idem",
        workspacePath: dedupPrDir,
      });
    } finally {
      spy2.mockRestore();
    }

    expect(firstResult.outputs.action).toBe("created");
    expect(secondResult.outputs.action).toBe("updated");
    expect(firstResult.outputs.prNumber).toBe(secondResult.outputs.prNumber);
  });
});

// ---------------------------------------------------------------
// Group 18: upsertDraftPr -- Error Handling (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- Error Handling", () => {
  let errorPrDir: string;

  beforeEach(async () => {
    errorPrDir = await createTempGitRepo();
    vi.stubEnv("GITHUB_TOKEN", "ghp_errortest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(errorPrDir, { recursive: true, force: true });
  });

  it("gh pr list failure returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: new Error("gh: connection refused"),
    });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-err-1",
        workspacePath: errorPrDir,
      });

      expect(result.summary).toMatch(/error|failed/i);
      expect(result.outputs).not.toHaveProperty("prUrl");
    } finally {
      spy.mockRestore();
    }
  });

  it("gh pr create failure returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: new Error("gh: permission denied creating PR"),
    });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-err-2",
        workspacePath: errorPrDir,
      });

      expect(result.summary).toMatch(/error|failed|create/i);
      expect(result.outputs).not.toHaveProperty("prUrl");
    } finally {
      spy.mockRestore();
    }
  });

  it("gh pr edit failure returns error result", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: '[{"number":10,"url":"https://github.com/org/repo/pull/10"}]',
      prEdit: new Error("gh: cannot edit PR - not authorized"),
    });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-err-3",
        workspacePath: errorPrDir,
      });

      expect(result.summary).toMatch(/error|failed|update/i);
      expect(result.outputs).not.toHaveProperty("prUrl");
    } finally {
      spy.mockRestore();
    }
  });

  it("error messages are sanitized to prevent token leakage", async () => {
    const secretToken = "ghp_SuperSecret";
    vi.stubEnv("GITHUB_TOKEN", secretToken);
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: new Error(`gh: authentication failed with token ${secretToken}`),
    });

    try {
      const result = await upsertDraftPr({
        title: "PR Title",
        body: "description",
        branchName: "bees/t-err-4",
        workspacePath: errorPrDir,
      });

      expect(result.summary).not.toContain(secretToken);

      // Verify logger calls do not contain the token value
      for (const mock of [mockError, mockWarn, mockInfo, mockDebug]) {
        for (const call of mock.mock.calls) {
          const serialized = JSON.stringify(call);
          expect(serialized).not.toContain(secretToken);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------
// Group 19: upsertDraftPr -- baseBranch Handling (Unit Tests)
// ---------------------------------------------------------------

describe("upsertDraftPr -- baseBranch Handling", () => {
  let basePrDir: string;

  beforeEach(async () => {
    basePrDir = await createTempGitRepo();
    vi.stubEnv("GITHUB_TOKEN", "ghp_basetest");
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(basePrDir, { recursive: true, force: true });
  });

  it("uses provided baseBranch when specified", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/101",
    });

    try {
      await upsertDraftPr({
        title: "Custom Base PR",
        body: "description",
        branchName: "bees/t-base-1",
        workspacePath: basePrDir,
        baseBranch: "develop",
      });

      // Find the gh pr create call and verify it includes --base develop
      const createCall = spy.mock.calls.find(
        (call) =>
          call[0] === "gh" &&
          (call[1] as string[])?.join(" ").includes("create"),
      );
      expect(createCall).toBeDefined();
      const createArgs = createCall![1] as string[];
      const baseIdx = createArgs.indexOf("--base");
      expect(baseIdx).toBeGreaterThan(-1);
      expect(createArgs[baseIdx + 1]).toBe("develop");
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults baseBranch to main when not specified", async () => {
    const { upsertDraftPr } = await loadUpsertPrModule();
    const spy = installGhMock({
      prList: "[]",
      prCreate: "https://github.com/org/repo/pull/102",
    });

    try {
      await upsertDraftPr({
        title: "Default Base PR",
        body: "description",
        branchName: "bees/t-base-2",
        workspacePath: basePrDir,
      });

      // Find the gh pr create call and verify it includes --base main
      const createCall = spy.mock.calls.find(
        (call) =>
          call[0] === "gh" &&
          (call[1] as string[])?.join(" ").includes("create"),
      );
      expect(createCall).toBeDefined();
      const createArgs = createCall![1] as string[];
      const baseIdx = createArgs.indexOf("--base");
      expect(baseIdx).toBeGreaterThan(-1);
      expect(createArgs[baseIdx + 1]).toBe("main");
    } finally {
      spy.mockRestore();
    }
  });
});
