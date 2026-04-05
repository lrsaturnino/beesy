/**
 * Prompt builder for CLI agent backends.
 *
 * Assembles agent prompts from multiple sources -- system prompt, skill files,
 * task context, and user prompt -- into a single temp file for CLI backend
 * consumption. CLI backends (cli-claude, cli-codex, cli-gemini) call this
 * module before spawning their subprocess, passing the resulting file path
 * via a flag or stdin.
 *
 * Assembly order is fixed:
 * 1. System prompt (from gate configuration, optional)
 * 2. Skills (loaded on-demand from skills/<name>/SKILL.md, optional)
 * 3. Context (pre-formatted payload + metadata, optional)
 * 4. User prompt (always present)
 *
 * Missing skill files produce a warning log but never block execution.
 * All optional sections are silently skipped when absent or empty.
 *
 * @module runners/prompt-builder
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createLogger } from "../utils/logger.js";

/** Default name for the skill content file within each skill directory. */
const SKILL_FILE_NAME = "SKILL.md";

/** Prefix for temp directories created to hold assembled prompt files. */
const TEMP_DIR_PREFIX = "bees-prompt-";

/** Section header labels inserted before each content block in the assembled prompt. */
const SECTION_HEADERS = {
  systemPrompt: "# System Prompt",
  skill: "# Skill",
  context: "# Context",
  userPrompt: "# User Prompt",
} as const;

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Options for building an assembled prompt file.
 *
 * @param systemPrompt  - System prompt from gate config (omitted when falsy)
 * @param skills        - Skill directory names to load from skills/<name>/SKILL.md
 * @param context       - Pre-formatted task context string (payload + metadata)
 * @param userPrompt    - The user prompt text (always required)
 * @param projectRoot   - Base directory for resolving skill file paths
 */
export interface PromptBuildOptions {
  /** System prompt override from gate configuration. Skipped when undefined or empty. */
  systemPrompt?: string;
  /** Skill directory names. Each resolves to skills/<name>/SKILL.md under projectRoot. */
  skills?: string[];
  /** Pre-formatted task context (payload + metadata). Skipped when undefined or empty. */
  context?: string;
  /** The user prompt text. Always included in the assembled output. */
  userPrompt: string;
  /** Base directory for resolving skill/<name>/SKILL.md paths. */
  projectRoot: string;
}

/**
 * Load the content of a single skill file.
 *
 * Constructs the path as `<projectRoot>/skills/<skillName>/SKILL.md` and
 * attempts to read it. On any filesystem error (missing directory, missing
 * file, permission denied), logs a warning with diagnostic context and
 * returns null so the caller can skip that skill gracefully.
 *
 * @internal Not exported -- used only by {@link buildPromptFile}.
 * @param projectRoot - Base directory containing the skills/ folder
 * @param skillName   - Directory name of the skill to load
 * @returns The skill file content, or null if the file could not be read
 */
async function loadSkillContent(
  projectRoot: string,
  skillName: string,
): Promise<string | null> {
  const skillPath = path.join(projectRoot, "skills", skillName, SKILL_FILE_NAME);
  try {
    return await readFile(skillPath, "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Skill "${skillName}" could not be loaded, skipping`, {
      skill: skillName,
      path: skillPath,
      error: message,
    });
    return null;
  }
}

/**
 * Build an assembled prompt file from multiple content sources.
 *
 * Concatenates non-empty sections in a fixed order (system prompt, skills,
 * context, user prompt) with section header markers and double-newline
 * separators, writes the result to a uniquely-named temp file in the OS
 * temp directory, and returns the absolute path to the created file.
 *
 * Each section is prefixed with a markdown heading for readability when
 * inspecting assembled prompt files during debugging. Skills are loaded
 * in parallel for efficiency.
 *
 * @param options - Prompt assembly options (see {@link PromptBuildOptions})
 * @returns Absolute path to the created temp file containing the assembled prompt
 * @throws If the temp directory or file cannot be created (filesystem error)
 */
export async function buildPromptFile(options: PromptBuildOptions): Promise<string> {
  const { systemPrompt, skills, context, userPrompt, projectRoot } = options;

  const sections: string[] = [];

  // Section 1: System prompt (skip when falsy)
  if (systemPrompt) {
    sections.push(`${SECTION_HEADERS.systemPrompt}\n\n${systemPrompt}`);
  }

  // Section 2: Skills (load each in parallel, skip missing ones)
  if (skills && skills.length > 0) {
    const loaded = await Promise.all(
      skills.map((name) => loadSkillContent(projectRoot, name)),
    );
    for (let i = 0; i < skills.length; i++) {
      const content = loaded[i];
      if (content !== null) {
        sections.push(
          `${SECTION_HEADERS.skill}: ${skills[i]}\n\n${content}`,
        );
      }
    }
  }

  // Section 3: Context (skip when falsy)
  if (context) {
    sections.push(`${SECTION_HEADERS.context}\n\n${context}`);
  }

  // Section 4: User prompt (always present)
  sections.push(`${SECTION_HEADERS.userPrompt}\n\n${userPrompt}`);

  // Join sections with double-newline separators for readability
  const assembled = sections.join("\n\n");

  return writeTempPromptFile(assembled);
}

/**
 * Write assembled prompt content to a uniquely-named temp file.
 *
 * Creates a new directory under the OS temp directory with a UUID-based name,
 * then writes the content as a UTF-8 markdown file within it. The unique
 * directory ensures no collisions even under concurrent invocations.
 *
 * @internal Not exported -- used only by {@link buildPromptFile}.
 * @param content - The assembled prompt content to write
 * @returns Absolute path to the created temp file
 */
async function writeTempPromptFile(content: string): Promise<string> {
  const tempDir = path.join(tmpdir(), `${TEMP_DIR_PREFIX}${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  const tempFilePath = path.join(tempDir, `prompt-${randomUUID()}.md`);
  await writeFile(tempFilePath, content, "utf-8");

  return tempFilePath;
}
