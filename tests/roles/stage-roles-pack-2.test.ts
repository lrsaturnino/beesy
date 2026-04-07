import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Role file descriptors: each entry defines metadata for one stage role.
// The test suite iterates these to generate parameterized test groups.
// ---------------------------------------------------------------------------

interface RoleDescriptor {
  /** Short name used in test titles (e.g., "knowledge-synthesis") */
  name: string;
  /** Relative path from project root to the role file */
  path: string;
  /** Domain keywords that the role content must include (OR-matched) */
  domainKeywords: string[];
}

const ROLES: RoleDescriptor[] = [
  {
    name: "knowledge-synthesis",
    path: "roles/implementation/knowledge-synthesis.md",
    domainKeywords: ["knowledge", "synthesis", "context", "codebase", "pattern"],
  },
  {
    name: "guidelines",
    path: "roles/implementation/guidelines.md",
    domainKeywords: ["guideline", "coding", "testing", "standard", "convention"],
  },
  {
    name: "task-breakdown",
    path: "roles/implementation/task-breakdown.md",
    domainKeywords: ["task", "breakdown", "atomic", "implement", "scope"],
  },
  {
    name: "implementation-coordinator",
    path: "roles/implementation/implementation-coordinator.md",
    domainKeywords: ["implementation", "coordinate", "batch", "bridge", "execution"],
  },
  {
    name: "delivery-coordinator",
    path: "roles/implementation/delivery-coordinator.md",
    domainKeywords: ["delivery", "commit", "push", "branch", "pull request"],
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
  it("knowledge-synthesis.md references knowledge context concepts", () => {
    const lower = roleContents["knowledge-synthesis"].toLowerCase();
    const terms = ["knowledge", "synthesis", "context", "codebase", "pattern"];
    const matchCount = terms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "knowledge-synthesis must reference at least 3 knowledge context concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("guidelines.md references coding and testing guideline concepts", () => {
    const lower = roleContents["guidelines"].toLowerCase();
    const terms = ["guideline", "coding", "testing", "standard", "convention"];
    const matchCount = terms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "guidelines must reference at least 3 coding and testing guideline concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("task-breakdown.md references task decomposition concepts", () => {
    const lower = roleContents["task-breakdown"].toLowerCase();
    const terms = ["task", "breakdown", "atomic", "implement", "scope"];
    const matchCount = terms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "task-breakdown must reference at least 3 task decomposition concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("implementation-coordinator.md references batch implementation concepts", () => {
    const lower = roleContents["implementation-coordinator"].toLowerCase();
    const terms = ["implementation", "coordinate", "batch", "bridge", "execution"];
    const matchCount = terms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "implementation-coordinator must reference at least 3 batch implementation concepts",
    ).toBeGreaterThanOrEqual(3);
  });

  it("delivery-coordinator.md references delivery pipeline concepts", () => {
    const lower = roleContents["delivery-coordinator"].toLowerCase();
    const terms = ["delivery", "commit", "push", "branch", "pull request"];
    const matchCount = terms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "delivery-coordinator must reference at least 3 delivery pipeline concepts",
    ).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Additional Tests: Task-Specific Requirements
// These verify that specific roles reference required scripts and concepts.
// ---------------------------------------------------------------------------

describe("Script Reference Requirements", () => {
  it("delivery-coordinator.md references all four delivery scripts", () => {
    const lower = roleContents["delivery-coordinator"].toLowerCase();
    const deliveryTerms = [
      "stage_explicit",
      "commit_with_trailers",
      "push_branch",
      "upsert_draft_pr",
      "stage",
      "commit",
      "push",
      "pull request",
      "draft pr",
    ];
    const matchCount = deliveryTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "delivery-coordinator must reference at least 3 delivery operations by name or concept",
    ).toBeGreaterThanOrEqual(3);
  });

  it("implementation-coordinator.md references batch_bridge script", () => {
    const lower = roleContents["implementation-coordinator"].toLowerCase();
    const bridgeTerms = [
      "batch_bridge",
      "batch bridge",
      "task pack",
      "memory bank",
      "bridge",
    ];
    const matchCount = bridgeTerms.filter((t) => lower.includes(t)).length;
    expect(
      matchCount,
      "implementation-coordinator must reference the bridge operation with at least 2 related terms",
    ).toBeGreaterThanOrEqual(2);
  });
});
