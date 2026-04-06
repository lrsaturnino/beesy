import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadBeesUsers,
  resolveUser,
  buildRequestedByTrailer,
  buildCoAuthoredByTrailer,
} from "../../src/delivery/bees-user.js";
import type { BeesUser } from "../../src/delivery/bees-user.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "bees-user-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Write a bees-users YAML config file into the temp directory and
 * return its absolute path.
 */
async function writeUsersYaml(content: string): Promise<string> {
  const configPath = path.join(tempDir, "bees-users.yaml");
  await writeFile(configPath, content, "utf-8");
  return configPath;
}

// -------------------------------------------------------------------
// YAML fixture constants
// -------------------------------------------------------------------

const VALID_FULL_USERS_YAML = `
users:
  - slackUserId: U001
    slackDisplayName: Alice
    githubLogin: alice-gh
    githubName: Alice Smith
    githubEmail: alice@example.com
  - slackUserId: U002
    slackDisplayName: Bob
    githubLogin: bob-gh
    githubName: Bob Jones
    githubEmail: bob@example.com
`;

const VALID_PARTIAL_GITHUB_YAML = `
users:
  - slackUserId: U003
    slackDisplayName: Charlie
`;

const VALID_MIXED_YAML = `
users:
  - slackUserId: U001
    slackDisplayName: Alice
    githubLogin: alice-gh
    githubName: Alice Smith
    githubEmail: alice@example.com
  - slackUserId: U004
    slackDisplayName: Dave
`;

const MISSING_SLACK_USER_ID_YAML = `
users:
  - slackDisplayName: NoId
    githubLogin: noid-gh
`;

const MISSING_SLACK_DISPLAY_NAME_YAML = `
users:
  - slackUserId: U005
    githubLogin: noname-gh
`;

const MISSING_BOTH_REQUIRED_YAML = `
users:
  - githubLogin: orphan-gh
    githubEmail: orphan@example.com
`;

const EMPTY_USERS_YAML = `
users: []
`;

const NULL_USERS_YAML = `
users:
`;

const MALFORMED_YAML = `{{{{not yaml at all!!!!}}}}`;

const DUPLICATE_SLACK_ID_YAML = `
users:
  - slackUserId: U001
    slackDisplayName: Alice
  - slackUserId: U001
    slackDisplayName: Alice Duplicate
`;

// -------------------------------------------------------------------
// Group 1: loadBeesUsers -- Valid Configurations
// -------------------------------------------------------------------

describe("loadBeesUsers -- Valid Configurations", () => {
  it("loads valid YAML with complete user entries", async () => {
    const configPath = await writeUsersYaml(VALID_FULL_USERS_YAML);
    const users = await loadBeesUsers(configPath);

    expect(users.size).toBe(2);
    expect(users.has("U001")).toBe(true);
    expect(users.has("U002")).toBe(true);

    const alice = users.get("U001")!;
    expect(alice.slackUserId).toBe("U001");
    expect(alice.slackDisplayName).toBe("Alice");
    expect(alice.githubLogin).toBe("alice-gh");
    expect(alice.githubName).toBe("Alice Smith");
    expect(alice.githubEmail).toBe("alice@example.com");

    const bob = users.get("U002")!;
    expect(bob.slackUserId).toBe("U002");
    expect(bob.slackDisplayName).toBe("Bob");
    expect(bob.githubLogin).toBe("bob-gh");
    expect(bob.githubName).toBe("Bob Jones");
    expect(bob.githubEmail).toBe("bob@example.com");
  });

  it("loads valid YAML with partial GitHub fields", async () => {
    const configPath = await writeUsersYaml(VALID_PARTIAL_GITHUB_YAML);
    const users = await loadBeesUsers(configPath);

    expect(users.size).toBe(1);

    const charlie = users.get("U003")!;
    expect(charlie.slackUserId).toBe("U003");
    expect(charlie.slackDisplayName).toBe("Charlie");
    expect(charlie.githubLogin).toBeUndefined();
    expect(charlie.githubName).toBeUndefined();
    expect(charlie.githubEmail).toBeUndefined();
  });

  it("loads valid YAML with mixed complete and partial users", async () => {
    const configPath = await writeUsersYaml(VALID_MIXED_YAML);
    const users = await loadBeesUsers(configPath);

    expect(users.size).toBe(2);

    const alice = users.get("U001")!;
    expect(alice.githubLogin).toBe("alice-gh");
    expect(alice.githubName).toBe("Alice Smith");
    expect(alice.githubEmail).toBe("alice@example.com");

    const dave = users.get("U004")!;
    expect(dave.slackDisplayName).toBe("Dave");
    expect(dave.githubLogin).toBeUndefined();
    expect(dave.githubName).toBeUndefined();
    expect(dave.githubEmail).toBeUndefined();
  });

  it("returns empty Map for empty users array", async () => {
    const configPath = await writeUsersYaml(EMPTY_USERS_YAML);
    const users = await loadBeesUsers(configPath);

    expect(users.size).toBe(0);
  });
});

// -------------------------------------------------------------------
// Group 2: loadBeesUsers -- Validation Errors
// -------------------------------------------------------------------

describe("loadBeesUsers -- Validation Errors", () => {
  it("rejects missing slackUserId", async () => {
    const configPath = await writeUsersYaml(MISSING_SLACK_USER_ID_YAML);

    await expect(loadBeesUsers(configPath)).rejects.toThrow(/slackUserId/i);
  });

  it("rejects missing slackDisplayName", async () => {
    const configPath = await writeUsersYaml(MISSING_SLACK_DISPLAY_NAME_YAML);

    await expect(loadBeesUsers(configPath)).rejects.toThrow(
      /slackDisplayName/i,
    );
  });

  it("rejects duplicate slackUserId", async () => {
    const configPath = await writeUsersYaml(DUPLICATE_SLACK_ID_YAML);

    await expect(loadBeesUsers(configPath)).rejects.toThrow(/duplicate/i);
  });

  it("rejects null users section", async () => {
    const configPath = await writeUsersYaml(NULL_USERS_YAML);

    await expect(loadBeesUsers(configPath)).rejects.toThrow();
  });

  it("rejects malformed YAML", async () => {
    const configPath = await writeUsersYaml(MALFORMED_YAML);

    await expect(loadBeesUsers(configPath)).rejects.toThrow(/YAML|parse/i);
  });

  it("collects multiple validation errors in a single pass", async () => {
    const configPath = await writeUsersYaml(MISSING_BOTH_REQUIRED_YAML);

    try {
      await loadBeesUsers(configPath);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/slackUserId/i);
      expect(message).toMatch(/slackDisplayName/i);
    }
  });
});

// -------------------------------------------------------------------
// Group 3: resolveUser
// -------------------------------------------------------------------

describe("resolveUser", () => {
  it("returns BeesUser for known slackUserId", async () => {
    const configPath = await writeUsersYaml(VALID_FULL_USERS_YAML);
    const users = await loadBeesUsers(configPath);

    const result = resolveUser(users, "U001");
    expect(result).not.toBeNull();
    expect(result!.slackUserId).toBe("U001");
    expect(result!.slackDisplayName).toBe("Alice");
    expect(result!.githubLogin).toBe("alice-gh");
  });

  it("returns null for unknown slackUserId", async () => {
    const configPath = await writeUsersYaml(VALID_FULL_USERS_YAML);
    const users = await loadBeesUsers(configPath);

    const result = resolveUser(users, "U999");
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 4: buildRequestedByTrailer
// -------------------------------------------------------------------

describe("buildRequestedByTrailer", () => {
  it("returns trailer with GitHub name when available", () => {
    const user: BeesUser = {
      slackUserId: "U001",
      slackDisplayName: "alice",
      githubLogin: "alice-gh",
      githubName: "Alice Smith",
      githubEmail: "alice@example.com",
    };

    expect(buildRequestedByTrailer(user)).toBe("Requested-by: Alice Smith");
  });

  it("returns trailer with Slack display name when no GitHub name", () => {
    const user: BeesUser = {
      slackUserId: "U003",
      slackDisplayName: "charlie",
    };

    expect(buildRequestedByTrailer(user)).toBe("Requested-by: charlie");
  });
});

// -------------------------------------------------------------------
// Group 5: buildCoAuthoredByTrailer
// -------------------------------------------------------------------

describe("buildCoAuthoredByTrailer", () => {
  it("returns trailer with full GitHub identity", () => {
    const user: BeesUser = {
      slackUserId: "U001",
      slackDisplayName: "alice",
      githubLogin: "alice-gh",
      githubName: "Alice Smith",
      githubEmail: "alice@example.com",
    };

    expect(buildCoAuthoredByTrailer(user)).toBe(
      "Co-authored-by: Alice Smith <alice@example.com>",
    );
  });

  it("returns null when GitHub email is missing", () => {
    const user: BeesUser = {
      slackUserId: "U001",
      slackDisplayName: "alice",
      githubName: "Alice Smith",
    };

    expect(buildCoAuthoredByTrailer(user)).toBeNull();
  });

  it("returns null when GitHub name is missing", () => {
    const user: BeesUser = {
      slackUserId: "U001",
      slackDisplayName: "alice",
      githubEmail: "alice@example.com",
    };

    expect(buildCoAuthoredByTrailer(user)).toBeNull();
  });

  it("returns null when both GitHub fields are missing", () => {
    const user: BeesUser = {
      slackUserId: "U003",
      slackDisplayName: "charlie",
    };

    expect(buildCoAuthoredByTrailer(user)).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 6: Integration -- YAML Fixture File Roundtrip
// -------------------------------------------------------------------

describe("YAML Config Integration", () => {
  it("config/bees-users.yaml loads correctly", async () => {
    const projectRoot = path.resolve(__dirname, "../..");
    const configPath = path.join(projectRoot, "config", "bees-users.yaml");

    const users = await loadBeesUsers(configPath);
    expect(users.size).toBeGreaterThanOrEqual(1);
  });
});
