import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Shared setup: load the role file once for all tests.
// Uses readFileSync to mirror the runtime loading mechanism in worker.ts.
// ---------------------------------------------------------------------------

const ROLE_FILE_PATH = path.resolve(
  process.cwd(),
  "roles/orchestrators/implementation.md",
);

let roleContent: string;

beforeAll(() => {
  roleContent = readFileSync(ROLE_FILE_PATH, "utf-8");
});

// -------------------------------------------------------------------
// Group 1: Role File Existence and Structure
// -------------------------------------------------------------------

describe("Role File Existence and Structure", () => {
  it("loads as valid UTF-8 with non-empty content", () => {
    expect(typeof roleContent).toBe("string");
    expect(roleContent.length).toBeGreaterThan(0);
  });

  it("line count is within the 30-80 range", () => {
    const lines = roleContent.split("\n");
    // Trim trailing empty lines for accurate count
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    expect(lines.length).toBeGreaterThanOrEqual(30);
    expect(lines.length).toBeLessThanOrEqual(80);
  });
});

// -------------------------------------------------------------------
// Group 2: Decision Dimension Coverage
// -------------------------------------------------------------------

describe("Decision Dimension Coverage", () => {
  it("covers when to queue a script", () => {
    const lower = roleContent.toLowerCase();
    const mentionsScript = lower.includes("script");
    const mentionsContext =
      lower.includes("catalog") ||
      lower.includes("allowed_scripts") ||
      lower.includes("run_script") ||
      lower.includes("queue");
    expect(
      mentionsScript && mentionsContext,
      "Role must reference scripts alongside catalog, allowed_scripts, run_script, or queue",
    ).toBe(true);
  });

  it("covers when to queue a stage-agent run", () => {
    const lower = roleContent.toLowerCase();
    const mentionsStage = lower.includes("stage");
    const mentionsTransition =
      lower.includes("transition") ||
      lower.includes("run_stage_agent") ||
      lower.includes("allowed_transitions") ||
      lower.includes("agent");
    expect(
      mentionsStage && mentionsTransition,
      "Role must reference stages alongside transitions, run_stage_agent, or allowed_transitions",
    ).toBe(true);
  });

  it("covers when to retry", () => {
    const lower = roleContent.toLowerCase();
    const hasRetryGuidance =
      lower.includes("retry") ||
      lower.includes("re-run") ||
      lower.includes("rerun") ||
      lower.includes("deficient");
    expect(
      hasRetryGuidance,
      "Role must contain retry, re-run, rerun, or deficient guidance",
    ).toBe(true);
  });

  it("covers when to revisit a prior stage", () => {
    const lower = roleContent.toLowerCase();
    const hasRevisitGuidance =
      lower.includes("revisit") ||
      lower.includes("prior stage") ||
      lower.includes("earlier stage") ||
      lower.includes("back to") ||
      lower.includes("return to");
    expect(
      hasRevisitGuidance,
      "Role must contain revisit, prior stage, earlier stage, back to, or return to guidance",
    ).toBe(true);
  });

  it("covers when to pause for human input", () => {
    const lower = roleContent.toLowerCase();
    const mentionsPause = lower.includes("pause") || lower.includes("human");
    const mentionsContext =
      lower.includes("input") ||
      lower.includes("ambiguit") ||
      lower.includes("pause_for_input");
    expect(
      mentionsPause && mentionsContext,
      "Role must reference pause or human alongside input, ambiguity, or pause_for_input",
    ).toBe(true);
  });

  it("covers when to finish", () => {
    const lower = roleContent.toLowerCase();
    const hasFinishGuidance =
      lower.includes("finish") ||
      lower.includes("finish_run") ||
      lower.includes("complet");
    expect(
      hasFinishGuidance,
      "Role must contain finish, finish_run, or completion guidance",
    ).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 3: Content Quality and Anti-Patterns
// -------------------------------------------------------------------

describe("Content Quality and Anti-Patterns", () => {
  it("does not encode workflow sequencing", () => {
    const lines = roleContent.split("\n");

    // Detect numbered imperative workflow steps like the monitoring-pilot
    // anti-pattern: "1. Execute the ...", "2. Optionally execute ...",
    // "3. Transition to the ..."
    // Numbered decision-dimension lists are acceptable; this targets
    // sequential imperative verbs that prescribe execution order.
    const workflowStepPattern =
      /^\s*\d+\.\s+(Execute|Run|Transition|Move|Start|Begin|Then|Next|After|Finally|First|Second|Third|Fourth)\b/i;

    const workflowSteps = lines.filter((line) =>
      workflowStepPattern.test(line),
    );

    expect(workflowSteps).toEqual([]);
  });

  it("references budget awareness", () => {
    const lower = roleContent.toLowerCase();
    const hasBudgetAwareness =
      lower.includes("budget") ||
      lower.includes("max_stage_retries") ||
      lower.includes("max_total_actions") ||
      (lower.includes("retri") && lower.includes("limit")) ||
      (lower.includes("action") && lower.includes("limit"));
    expect(
      hasBudgetAwareness,
      "Role must reference budget, max_stage_retries, max_total_actions, or retry/action limits",
    ).toBe(true);
  });

  it("references script catalog awareness", () => {
    const lower = roleContent.toLowerCase();
    const hasScriptCatalogAwareness =
      lower.includes("catalog") ||
      lower.includes("allowed_scripts") ||
      lower.includes("script catalog") ||
      (lower.includes("script") && lower.includes("allowlist"));
    expect(
      hasScriptCatalogAwareness,
      "Role must reference catalog, allowed_scripts, script catalog, or script allowlist",
    ).toBe(true);
  });

  it("references journal for decision context", () => {
    const lower = roleContent.toLowerCase();
    const hasJournalReference =
      lower.includes("journal") ||
      lower.includes("decision history") ||
      lower.includes("prior decision") ||
      lower.includes("run history");
    expect(
      hasJournalReference,
      "Role must reference journal, decision history, prior decisions, or run history",
    ).toBe(true);
  });

  it("includes anti-thrashing guidance", () => {
    const lower = roleContent.toLowerCase();
    const hasAntiThrashing =
      lower.includes("thrash") ||
      lower.includes("bouncing") ||
      lower.includes("aimless") ||
      lower.includes("looping") ||
      (lower.includes("avoid") && lower.includes("cycling")) ||
      (lower.includes("measurable") && lower.includes("progress"));
    expect(
      hasAntiThrashing,
      "Role must contain anti-thrashing guidance (thrash, bouncing, aimless, looping, or measurable progress)",
    ).toBe(true);
  });

  it("includes anti-spam guidance", () => {
    const lower = roleContent.toLowerCase();
    const hasAntiSpam =
      lower.includes("gratuitous") ||
      lower.includes("unnecessary") ||
      lower.includes("speculative") ||
      lower.includes("spam") ||
      (lower.includes("script") &&
        (lower.includes("demonstrabl") || lower.includes("concrete")));
    expect(
      hasAntiSpam,
      "Role must contain anti-spam guidance (gratuitous, unnecessary, speculative, or concrete justification)",
    ).toBe(true);
  });
});

// -------------------------------------------------------------------
// Group 4: Integration with Prompt Rendering
// -------------------------------------------------------------------

describe("Integration with Prompt Rendering", () => {
  it("renders correctly in the # Role section without breaking prompt format", () => {
    // Simulate what renderOrchestratorPrompt does at worker.ts:198:
    //   sections.push(`# Role\n\n${roleContent}`)
    const renderedSection = `# Role\n\n${roleContent}`;

    // The rendered section starts with the role header
    expect(renderedSection.startsWith("# Role\n\n")).toBe(true);

    // The role content appears verbatim after the header
    expect(renderedSection).toContain(roleContent);

    // The role content must not contain other top-level prompt section
    // headers which would break the three-section format used by
    // renderOrchestratorPrompt (# Role / # Task / # Output)
    expect(roleContent).not.toContain("# Task");
    expect(roleContent).not.toContain("# Output");
  });
});
