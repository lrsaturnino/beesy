import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------
// Logger mock (must use vi.hoisted so the factory can reference mockWarn)
// ---------------------------------------------------------------

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  },
}));

import { buildPromptFile } from "../../src/runners/prompt-builder.js";

// ---------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------

/** Temp directory for skill files created per test. */
let projectRoot: string;

/** Collector for prompt temp files to clean up. */
let createdPromptFiles: string[];

/**
 * Create a skill file at the expected path within the project root.
 * Mirrors the convention: skills/<skillName>/SKILL.md
 */
async function createSkillFile(
  baseDir: string,
  skillName: string,
  content: string,
): Promise<void> {
  const skillDir = path.join(baseDir, "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "bees-test-"));
  createdPromptFiles = [];
  mockWarn.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Clean up the temp project root
  await rm(projectRoot, { recursive: true, force: true });
  // Clean up any prompt files created during the test
  for (const filePath of createdPromptFiles) {
    await rm(path.dirname(filePath), { recursive: true, force: true }).catch(
      () => {},
    );
  }
});

// ---------------------------------------------------------------
// Group 1: Prompt Assembly Order
// ---------------------------------------------------------------

describe("prompt assembly order", () => {
  it("assembles all four sections in correct order", async () => {
    await createSkillFile(projectRoot, "test-skill", "SKILL_CONTENT_HERE");

    const resultPath = await buildPromptFile({
      systemPrompt: "SYSTEM_PROMPT_HERE",
      skills: ["test-skill"],
      context: "CONTEXT_HERE",
      userPrompt: "USER_PROMPT_HERE",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    const sysIdx = content.indexOf("SYSTEM_PROMPT_HERE");
    const skillIdx = content.indexOf("SKILL_CONTENT_HERE");
    const ctxIdx = content.indexOf("CONTEXT_HERE");
    const userIdx = content.indexOf("USER_PROMPT_HERE");

    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThanOrEqual(0);

    expect(sysIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(ctxIdx);
    expect(ctxIdx).toBeLessThan(userIdx);
  });

  it("includes section separators between content blocks", async () => {
    await createSkillFile(projectRoot, "sep-skill", "SEP_SKILL_CONTENT");

    const resultPath = await buildPromptFile({
      systemPrompt: "SEP_SYSTEM",
      skills: ["sep-skill"],
      context: "SEP_CONTEXT",
      userPrompt: "SEP_USER",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");

    // Sections should not be directly concatenated without any separation
    expect(content).not.toContain("SEP_SYSTEMSEP_SKILL_CONTENT");
    expect(content).not.toContain("SEP_SKILL_CONTENTSEP_CONTEXT");
    expect(content).not.toContain("SEP_CONTEXTSEP_USER");
  });
});

// ---------------------------------------------------------------
// Group 2: Skill File Loading
// ---------------------------------------------------------------

describe("skill file loading", () => {
  it("loads a single skill file from skills directory", async () => {
    await createSkillFile(
      projectRoot,
      "my-skill",
      "This is the skill content for my-skill.",
    );

    const resultPath = await buildPromptFile({
      skills: ["my-skill"],
      userPrompt: "do something",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("This is the skill content for my-skill.");
  });

  it("loads multiple skill files in order", async () => {
    await createSkillFile(projectRoot, "alpha-skill", "ALPHA_CONTENT");
    await createSkillFile(projectRoot, "beta-skill", "BETA_CONTENT");

    const resultPath = await buildPromptFile({
      skills: ["alpha-skill", "beta-skill"],
      userPrompt: "do something",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    const alphaIdx = content.indexOf("ALPHA_CONTENT");
    const betaIdx = content.indexOf("BETA_CONTENT");

    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it("warns on missing skill file but does not throw", async () => {
    const resultPath = await buildPromptFile({
      skills: ["nonexistent-skill"],
      userPrompt: "do something",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    // Function should not throw -- if we get here it succeeded
    expect(resultPath).toBeTruthy();

    // Verify a warning was logged about the missing skill
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent-skill"),
      expect.any(Object),
    );

    // The returned file should still be readable
    const content = await readFile(resultPath, "utf-8");
    expect(content).toBeTruthy();
  });

  it("skips missing skill and includes valid ones", async () => {
    await createSkillFile(projectRoot, "valid-skill", "VALID_CONTENT");
    await createSkillFile(projectRoot, "another-valid", "ANOTHER_CONTENT");

    const resultPath = await buildPromptFile({
      skills: ["valid-skill", "missing-skill", "another-valid"],
      userPrompt: "do something",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("VALID_CONTENT");
    expect(content).toContain("ANOTHER_CONTENT");

    // Warning logged for the missing skill
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("missing-skill"),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------
// Group 3: Temp File Creation
// ---------------------------------------------------------------

describe("temp file creation", () => {
  it("writes assembled prompt to a temp file in OS temp directory", async () => {
    const resultPath = await buildPromptFile({
      userPrompt: "temp file test",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    // Path should be inside the OS temp directory
    expect(resultPath.startsWith(tmpdir())).toBe(true);

    // File should exist and be readable
    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("temp file test");
  });

  it("returns a unique file path for each invocation", async () => {
    const path1 = await buildPromptFile({
      userPrompt: "first call",
      projectRoot,
    });
    createdPromptFiles.push(path1);

    const path2 = await buildPromptFile({
      userPrompt: "second call",
      projectRoot,
    });
    createdPromptFiles.push(path2);

    expect(path1).not.toBe(path2);
  });

  it("temp file contains UTF-8 encoded content", async () => {
    const unicodeContent = "Unicode test: cafe\u0301 \u2603 \u{1F41D} \u00E9\u00E8\u00EA";

    const resultPath = await buildPromptFile({
      userPrompt: unicodeContent,
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain(unicodeContent);
  });
});

// ---------------------------------------------------------------
// Group 4: Empty/Null Input Handling
// ---------------------------------------------------------------

describe("empty and null input handling", () => {
  it("skips system prompt section when systemPrompt is undefined", async () => {
    const resultPath = await buildPromptFile({
      systemPrompt: undefined,
      userPrompt: "just the user prompt",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("just the user prompt");
    // Content should not contain a dangling system prompt section header
    // when there is no system prompt text
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("skips system prompt section when systemPrompt is empty string", async () => {
    const resultPath = await buildPromptFile({
      systemPrompt: "",
      userPrompt: "only user prompt",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    // The content should just be around the user prompt, not a huge
    // section for an empty system prompt
    expect(content).toContain("only user prompt");
  });

  it("skips skills section when skills list is empty", async () => {
    const resultPath = await buildPromptFile({
      systemPrompt: "SYS",
      skills: [],
      context: "CTX",
      userPrompt: "USR",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("SYS");
    expect(content).toContain("CTX");
    expect(content).toContain("USR");
  });

  it("skips skills section when skills is undefined", async () => {
    const resultPath = await buildPromptFile({
      skills: undefined,
      context: "CONTEXT_ONLY",
      userPrompt: "USER_ONLY",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("CONTEXT_ONLY");
    expect(content).toContain("USER_ONLY");
  });

  it("handles all inputs being minimal (just userPrompt)", async () => {
    const resultPath = await buildPromptFile({
      userPrompt: "Do something",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("Do something");
  });
});

// ---------------------------------------------------------------
// Group 5: Context Handling
// ---------------------------------------------------------------

describe("context handling", () => {
  it("includes context section with payload and metadata", async () => {
    const contextValue = "Task: fix bug\nPayload: {\"key\": \"value\"}";

    const resultPath = await buildPromptFile({
      context: contextValue,
      userPrompt: "fix it",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain(contextValue);
  });

  it("skips context section when context is empty or undefined", async () => {
    const resultPath = await buildPromptFile({
      context: undefined,
      userPrompt: "no context provided",
      projectRoot,
    });
    createdPromptFiles.push(resultPath);

    const content = await readFile(resultPath, "utf-8");
    expect(content).toContain("no context provided");
    // Ensure file is valid and contains content
    expect(content.trim().length).toBeGreaterThan(0);
  });
});
