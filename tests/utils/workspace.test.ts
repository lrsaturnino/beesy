import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";

// ---------------------------------------------------------------
// Logger mock (must use vi.hoisted so the factory can reference mocks)
// ---------------------------------------------------------------

const { mockWarn, mockInfo, mockError, mockDebug, setGitUnavailable } = vi.hoisted(() => {
  return {
    mockWarn: vi.fn(),
    mockInfo: vi.fn(),
    mockError: vi.fn(),
    mockDebug: vi.fn(),
    /** When true, any execSync call containing "git" throws. */
    setGitUnavailable: { value: false },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: (...args: Parameters<typeof actual.execSync>) => {
      if (setGitUnavailable.value && typeof args[0] === "string" && args[0].includes("git")) {
        throw new Error("command not found: git");
      }
      return actual.execSync(...args);
    },
  };
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
// Module under test (does not exist yet -- expected to fail in RED phase)
// ---------------------------------------------------------------

import {
  createWorkspace,
  cleanupWorkspace,
  slugifyTitle,
} from "../../src/utils/workspace.js";

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

/**
 * Create a temporary git repository suitable for worktree operations.
 * Sets up a repo with an initial commit on the main branch, which is
 * required before any worktree can be added.
 */
async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bees-ws-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git checkout -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Run a git command in the specified directory and return trimmed stdout.
 */
function execGit(cwd: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/** Check whether a directory exists on the filesystem. */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Shared state for integration tests
// ---------------------------------------------------------------

let tempRepoDir: string;

// ---------------------------------------------------------------
// Group 1: Title Slugification (Unit Tests)
// ---------------------------------------------------------------

describe("slugifyTitle", () => {
  it("converts spaces to hyphens", () => {
    expect(slugifyTitle("Hello World")).toBe("hello-world");
  });

  it("converts to lowercase", () => {
    expect(slugifyTitle("BalanceOwner Redemption Fix")).toBe(
      "balanceowner-redemption-fix",
    );
  });

  it("removes special characters", () => {
    expect(slugifyTitle("Fix bug #42 (urgent!)")).toBe("fix-bug-42-urgent");
  });

  it("truncates at 50 characters", () => {
    const longTitle =
      "This is a very long title that should be truncated because it exceeds the maximum allowed length";
    const result = slugifyTitle(longTitle);
    expect(result.length).toBeLessThanOrEqual(50);
    // Must not end with a hyphen after truncation
    expect(result.endsWith("-")).toBe(false);
  });

  it("collapses multiple hyphens", () => {
    expect(slugifyTitle("fix---multiple   spaces")).toBe(
      "fix-multiple-spaces",
    );
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyTitle(" -leading and trailing- ")).toBe(
      "leading-and-trailing",
    );
  });

  it("handles empty string", () => {
    expect(slugifyTitle("")).toBe("");
  });

  it("handles string with only special characters", () => {
    expect(slugifyTitle("!@#$%^&*()")).toBe("");
  });
});

// ---------------------------------------------------------------
// Group 2: Branch Name Generation (Unit Tests)
// ---------------------------------------------------------------

describe("branch name generation", () => {
  it("generates branch with convention bees/<task-id>-<slug>", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const worktreePath = path.join(repoDir, "wt-branch-test");
      const result = await createWorkspace({
        repoPath: repoDir,
        worktreePath,
        taskId: "task-0042",
        title: "BalanceOwner Redemption Fix",
      });

      expect(result.success).toBe(true);
      expect(result.branchName).toBe(
        "bees/task-0042-balanceowner-redemption-fix",
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("uses custom branch prefix when provided", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const worktreePath = path.join(repoDir, "wt-prefix-test");
      const result = await createWorkspace({
        repoPath: repoDir,
        worktreePath,
        taskId: "task-001",
        title: "fix bug",
        branchPrefix: "custom/",
      });

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("custom/task-001-fix-bug");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("handles long titles by truncating slug portion only", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const worktreePath = path.join(repoDir, "wt-long-test");
      const longTitle =
        "This is a very long task title that will definitely exceed the fifty character slug limit";
      const result = await createWorkspace({
        repoPath: repoDir,
        worktreePath,
        taskId: "task-001",
        title: longTitle,
      });

      expect(result.success).toBe(true);
      // The prefix "bees/" and task-id "task-001-" must be preserved
      expect(result.branchName).toMatch(/^bees\/task-001-/);
      // The slug portion (after "bees/task-001-") must be <= 50 chars
      const slugPortion = result.branchName!.replace("bees/task-001-", "");
      expect(slugPortion.length).toBeLessThanOrEqual(50);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------
// Group 3: Git Availability Check (Unit/Integration)
// ---------------------------------------------------------------

describe("git availability", () => {
  it("detects when git is available", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const worktreePath = path.join(repoDir, "wt-git-check");
      const result = await createWorkspace({
        repoPath: repoDir,
        worktreePath,
        taskId: "task-001",
        title: "git check",
      });

      // Should succeed, meaning git was found
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("returns graceful error when git is not available", async () => {
    // Activate the git-unavailable flag so the mocked execSync throws
    // for any command containing "git".
    setGitUnavailable.value = true;

    try {
      const result = await createWorkspace({
        repoPath: "/tmp/fake-repo",
        worktreePath: "/tmp/fake-worktree",
        taskId: "task-001",
        title: "no git",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain("git");
    } finally {
      setGitUnavailable.value = false;
    }
  });
});

// ---------------------------------------------------------------
// Group 4: Worktree Creation (Integration Tests)
// ---------------------------------------------------------------

describe("worktree creation", () => {
  beforeEach(async () => {
    tempRepoDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    // Clean up worktrees before removing the repo directory.
    // This prevents orphaned .git/worktrees entries.
    try {
      const worktreeList = execGit(tempRepoDir, "worktree", "list", "--porcelain");
      const worktreePaths = worktreeList
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.replace("worktree ", ""))
        .filter((p) => p !== tempRepoDir);

      for (const wt of worktreePaths) {
        try {
          execSync(`git -C "${tempRepoDir}" worktree remove --force "${wt}"`, {
            stdio: "pipe",
          });
        } catch {
          // Worktree may already be cleaned up
        }
      }
    } catch {
      // Repo may already be gone
    }
    await rm(tempRepoDir, { recursive: true, force: true });
  });

  it("creates a worktree at the specified path from main branch", async () => {
    const worktreePath = path.join(tempRepoDir, "worktree-output");
    const result = await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-001",
      title: "create worktree test",
    });

    expect(result.success).toBe(true);

    // Worktree directory should exist
    const exists = await directoryExists(worktreePath);
    expect(exists).toBe(true);

    // Verify the correct branch is checked out
    const currentBranch = execGit(worktreePath, "branch", "--show-current");
    expect(currentBranch).toBe("bees/task-001-create-worktree-test");
  });

  it("configures bees-bot identity in the worktree", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-identity");
    await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-002",
      title: "identity test",
    });

    const userName = execGit(worktreePath, "config", "user.name");
    const userEmail = execGit(worktreePath, "config", "user.email");

    expect(userName).toBe("bees-bot");
    expect(userEmail).toBe("bees@t-labs.dev");
  });

  it("configures custom git identity when provided", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-custom-id");
    await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-003",
      title: "custom identity",
      gitIdentity: {
        name: "custom-bot",
        email: "custom@example.com",
      },
    });

    const userName = execGit(worktreePath, "config", "user.name");
    const userEmail = execGit(worktreePath, "config", "user.email");

    expect(userName).toBe("custom-bot");
    expect(userEmail).toBe("custom@example.com");
  });

  it("returns workspace path on success", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-return-path");
    const result = await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-004",
      title: "return path test",
    });

    expect(result.success).toBe(true);
    expect(result.workspacePath).toBe(worktreePath);
  });

  it("handles worktree already exists gracefully", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-duplicate");

    // First creation should succeed
    const first = await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-005",
      title: "duplicate test",
    });
    expect(first.success).toBe(true);

    // Second creation with same path should fail gracefully
    const second = await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-005",
      title: "duplicate test",
    });
    expect(second.success).toBe(false);
    expect(second.error).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 5: Worktree Cleanup (Integration Tests)
// ---------------------------------------------------------------

describe("worktree cleanup", () => {
  beforeEach(async () => {
    tempRepoDir = await createTempGitRepo();
    mockDebug.mockClear();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(async () => {
    await rm(tempRepoDir, { recursive: true, force: true });
  });

  it("removes worktree and verifies directory is gone", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-cleanup");

    // Create the worktree first
    const createResult = await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-006",
      title: "cleanup test",
    });
    expect(createResult.success).toBe(true);

    // Clean up the worktree
    const cleanupResult = await cleanupWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
    });
    expect(cleanupResult.success).toBe(true);

    // Directory should no longer exist
    const exists = await directoryExists(worktreePath);
    expect(exists).toBe(false);

    // Worktree should not appear in git worktree list
    const worktreeList = execGit(tempRepoDir, "worktree", "list");
    expect(worktreeList).not.toContain(worktreePath);
  });

  it("deletes the branch when deleteBranch option is true", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-delete-branch");
    const branchName = "bees/task-007-branch-delete-test";

    await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-007",
      title: "branch delete test",
    });

    await cleanupWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      deleteBranch: true,
      branchName,
    });

    // Branch should no longer exist
    const branches = execGit(tempRepoDir, "branch", "--list", branchName);
    expect(branches).toBe("");
  });

  it("preserves the branch when deleteBranch option is false", async () => {
    const worktreePath = path.join(tempRepoDir, "wt-keep-branch");
    const branchName = "bees/task-008-branch-preserve-test";

    await createWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      taskId: "task-008",
      title: "branch preserve test",
    });

    await cleanupWorkspace({
      repoPath: tempRepoDir,
      worktreePath,
      deleteBranch: false,
    });

    // Branch should still exist
    const branches = execGit(tempRepoDir, "branch", "--list", branchName);
    expect(branches).toContain(branchName);
  });

  it("handles cleanup of non-existent worktree gracefully", async () => {
    const fakePath = path.join(tempRepoDir, "wt-does-not-exist");

    const result = await cleanupWorkspace({
      repoPath: tempRepoDir,
      worktreePath: fakePath,
    });

    // Should not throw, should return gracefully
    expect(result.success).toBe(true);
  });
});
