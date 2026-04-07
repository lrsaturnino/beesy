import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Role file descriptors: each entry defines metadata for one stage role.
// The test suite iterates these to generate parameterized test groups.
// ---------------------------------------------------------------------------

interface RoleDescriptor {
  /** Short name used in test titles (e.g., "planning-check") */
  name: string;
  /** Relative path from project root to the role file */
  path: string;
  /** Domain keywords that the role content must include (OR-matched) */
  domainKeywords: string[];
}

const ROLES: RoleDescriptor[] = [
  {
    name: "planning-check",
    path: "roles/implementation/planning-check.md",
    domainKeywords: ["exist", "detect", "assess", "usable", "plan"],
  },
  {
    name: "planning-create",
    path: "roles/implementation/planning-create.md",
    domainKeywords: ["plan", "create", "structure", "implementation", "requirement"],
  },
  {
    name: "historical-search",
    path: "roles/implementation/historical-search.md",
    domainKeywords: ["history", "search", "repository", "pattern", "solution"],
  },
  {
    name: "planning-adjust",
    path: "roles/implementation/planning-adjust.md",
    domainKeywords: ["revise", "adjust", "feedback", "finding", "update", "incorporate"],
  },
  {
    name: "codebase-map",
    path: "roles/implementation/codebase-map.md",
    domainKeywords: ["map", "structure", "dependency", "file", "code", "module"],
  },
];

// ---------------------------------------------------------------------------
// Shared setup: load all role files once. Store as a map keyed by role name.
// Missing files produce an empty string so individual tests can assert on
// the absence rather than crashing the entire suite.
// ---------------------------------------------------------------------------

const roleContents: Record<string, string> = {};

beforeAll(() => {
  for (const role of ROLES) {
    const fullPath = path.resolve(process.cwd(), role.path);
    try {
      roleContents[role.name] = readFileSync(fullPath, "utf-8");
    } catch {
      // Store empty string so tests can detect the missing file
      roleContents[role.name] = "";
    }
  }
});

// ---------------------------------------------------------------------------
// Anti-pattern regex: detects numbered imperative workflow steps.
// Matches lines like "1. Execute the ...", "2. Run the ...", etc.
// Mirrors the pattern in orchestrator-role.test.ts.
// ---------------------------------------------------------------------------

const WORKFLOW_STEP_PATTERN =
  /^\s*\d+\.\s+(Execute|Run|Transition|Move|Start|Begin|Then|Next|After|Finally|First|Second|Third|Fourth)\b/i;

// ---------------------------------------------------------------------------
// Parameterized test groups per role
// ---------------------------------------------------------------------------

for (const role of ROLES) {
  describe(`Stage role: ${role.name}`, () => {
    // -----------------------------------------------------------------
    // Group 1: File Existence and Structure
    // -----------------------------------------------------------------

    describe("File Existence and Structure", () => {
      it("loads as valid UTF-8 with non-empty content", () => {
        const content = roleContents[role.name];
        expect(typeof content).toBe("string");
        expect(
          content.length,
          `Role file ${role.path} must have non-empty content`,
        ).toBeGreaterThan(0);
      });

      it("line count is within the 30-80 range", () => {
        const content = roleContents[role.name];
        const lines = content.split("\n");
        // Trim trailing empty lines for accurate count
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
          lines.pop();
        }
        expect(
          lines.length,
          `Role file ${role.name} has ${lines.length} lines (expected 30-80)`,
        ).toBeGreaterThanOrEqual(30);
        expect(
          lines.length,
          `Role file ${role.name} has ${lines.length} lines (expected 30-80)`,
        ).toBeLessThanOrEqual(80);
      });
    });

    // -----------------------------------------------------------------
    // Group 2: Required Section Presence
    // -----------------------------------------------------------------

    describe("Required Section Presence", () => {
      it("contains Identity section", () => {
        const lower = roleContents[role.name].toLowerCase();
        const hasIdentity =
          lower.includes("you are a") ||
          lower.includes("# identity") ||
          lower.includes("responsible for") ||
          lower.includes("your role");
        expect(
          hasIdentity,
          `Role ${role.name} must contain identity markers (you are a, # identity, responsible for, your role)`,
        ).toBe(true);
      });

      it("contains Standards section", () => {
        const lower = roleContents[role.name].toLowerCase();
        const hasStandards =
          lower.includes("standard") ||
          lower.includes("quality") ||
          lower.includes("format") ||
          lower.includes("completeness") ||
          lower.includes("criteria");
        expect(
          hasStandards,
          `Role ${role.name} must contain standards markers (standard, quality, format, completeness, criteria)`,
        ).toBe(true);
      });

      it("contains Constraints section", () => {
        const lower = roleContents[role.name].toLowerCase();
        const hasConstraints =
          lower.includes("constraint") ||
          lower.includes("must not") ||
          lower.includes("do not") ||
          lower.includes("avoid") ||
          lower.includes("never");
        expect(
          hasConstraints,
          `Role ${role.name} must contain constraint markers (constraint, must not, do not, avoid, never)`,
        ).toBe(true);
      });

      it("contains Output contract section", () => {
        const lower = roleContents[role.name].toLowerCase();
        const hasOutputContract =
          lower.includes("output") ||
          lower.includes("produce") ||
          lower.includes("deliver") ||
          lower.includes("format");
        expect(
          hasOutputContract,
          `Role ${role.name} must contain output contract markers (output, produce, deliver, format)`,
        ).toBe(true);
      });
    });

    // -----------------------------------------------------------------
    // Group 3: Content Quality and Anti-Patterns
    // -----------------------------------------------------------------

    describe("Content Quality and Anti-Patterns", () => {
      it("does not encode workflow sequencing", () => {
        const content = roleContents[role.name];
        const lines = content.split("\n");
        const workflowSteps = lines.filter((line) =>
          WORKFLOW_STEP_PATTERN.test(line),
        );
        expect(
          workflowSteps,
          `Role ${role.name} must not contain workflow sequencing steps: ${workflowSteps.join(", ")}`,
        ).toEqual([]);
      });

      it("does not contain top-level prompt section headers", () => {
        const content = roleContents[role.name];
        expect(
          content.includes("# Task"),
          `Role ${role.name} must not contain "# Task" header`,
        ).toBe(false);
        expect(
          content.includes("# Output"),
          `Role ${role.name} must not contain "# Output" header`,
        ).toBe(false);
      });

      it("references only its own domain concerns", () => {
        const lower = roleContents[role.name].toLowerCase();
        const matchCount = role.domainKeywords.filter((kw) =>
          lower.includes(kw),
        ).length;
        expect(
          matchCount,
          `Role ${role.name} must contain at least 3 of its domain keywords: [${role.domainKeywords.join(", ")}]`,
        ).toBeGreaterThanOrEqual(3);
      });
    });

    // -----------------------------------------------------------------
    // Group 4: Integration with Prompt Rendering
    // -----------------------------------------------------------------

    describe("Integration with Prompt Rendering", () => {
      it("renders correctly in the # Role section without breaking prompt format", () => {
        const content = roleContents[role.name];
        // Simulate what renderPrompt does at stage-agent-handler.ts:390:
        //   sections.push(`# Role\n\n${roleContent}`)
        const renderedSection = `# Role\n\n${content}`;

        // The rendered section starts with the role header
        expect(renderedSection.startsWith("# Role\n\n")).toBe(true);

        // The role content appears verbatim after the header
        expect(renderedSection).toContain(content);

        // The role content must not contain other top-level prompt section
        // headers which would break the three-section format used by
        // renderPrompt (# Role / # Task / # Output)
        expect(content).not.toContain("# Task");
        expect(content).not.toContain("# Output");
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Stage-Specific Content Checks
// These tests verify that each role references concepts unique to its domain.
// ---------------------------------------------------------------------------

describe("Stage-Specific Content", () => {
  it("planning-check.md references plan detection concepts", () => {
    const lower = roleContents["planning-check"].toLowerCase();
    const detectionTerms = ["exist", "detect", "assess", "usable", "plan"];
    const matchCount = detectionTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "planning-check must reference at least 3 plan detection concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("planning-create.md references plan creation concepts", () => {
    const lower = roleContents["planning-create"].toLowerCase();
    const creationTerms = ["plan", "create", "structure", "implementation", "requirement"];
    const matchCount = creationTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "planning-create must reference at least 3 plan creation concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("historical-search.md references repository analysis concepts", () => {
    const lower = roleContents["historical-search"].toLowerCase();
    const analysisTerms = ["history", "search", "repository", "pattern", "solution"];
    const matchCount = analysisTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "historical-search must reference at least 3 repository analysis concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("planning-adjust.md references plan revision concepts", () => {
    const lower = roleContents["planning-adjust"].toLowerCase();
    const revisionTerms = ["revise", "adjust", "feedback", "finding", "update", "incorporate"];
    const matchCount = revisionTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "planning-adjust must reference at least 3 plan revision concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("codebase-map.md references code structure mapping concepts", () => {
    const lower = roleContents["codebase-map"].toLowerCase();
    const mappingTerms = ["map", "structure", "dependency", "file", "code", "module"];
    const matchCount = mappingTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "codebase-map must reference at least 3 code structure mapping concepts",
    ).toBeGreaterThanOrEqual(3);
  });
});
