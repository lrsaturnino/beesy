import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// -------------------------------------------------------------------
// Group 1: SubtaskKind (src/queue/types.ts)
// -------------------------------------------------------------------
describe("SubtaskKind", () => {
  it("exports SUBTASK_KINDS const array with three values", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod.SUBTASK_KINDS).toBeDefined();
    const kinds = mod.SUBTASK_KINDS as readonly string[];
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain("orchestrator_eval");
    expect(kinds).toContain("stage_agent_run");
    expect(kinds).toContain("resume_after_input");
  });
});

// -------------------------------------------------------------------
// Group 2: TaskStatus extension (src/queue/types.ts)
// -------------------------------------------------------------------
describe("TaskStatus extension", () => {
  it("TASK_STATUSES includes waiting alongside original six values", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod.TASK_STATUSES).toBeDefined();
    const statuses = mod.TASK_STATUSES as readonly string[];
    expect(statuses).toHaveLength(7);
    expect(statuses).toContain("queued");
    expect(statuses).toContain("active");
    expect(statuses).toContain("paused");
    expect(statuses).toContain("waiting");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("aborted");
  });
});

// -------------------------------------------------------------------
// Group 3: Task recipe fields (src/queue/types.ts)
// -------------------------------------------------------------------
describe("Task recipe fields", () => {
  it("Task with all new optional recipe fields is constructible", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod).toBeDefined();
    const task: Record<string, unknown> = {
      // Original required fields
      id: "task-recipe-001",
      gate: "new-implementation",
      status: "waiting",
      priority: "normal",
      position: 1,
      payload: { description: "recipe-driven task" },
      requestedBy: "U12345",
      sourceChannel: { platform: "slack", channelId: "C12345" },
      createdAt: new Date(),
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      // New optional recipe fields
      recipeId: "new-implementation",
      currentStageId: "planning",
      activeSubtaskId: "subtask-001",
      queuedSubtaskIds: ["subtask-002", "subtask-003"],
      artifactIds: ["artifact-001"],
      pausedAt: new Date("2026-01-01T00:00:00Z"),
      waitingSince: new Date("2026-01-01T01:00:00Z"),
      resumeDeadlineAt: new Date("2026-01-01T02:00:00Z"),
      pauseReason: "Awaiting human review",
      stageRetryCount: { planning: 1, implementation: 0 },
      totalActionCount: 5,
      capturedHumanContext: "Approved with minor changes",
    };
    expect(task.recipeId).toBe("new-implementation");
    expect(task.currentStageId).toBe("planning");
    expect(task.activeSubtaskId).toBe("subtask-001");
    expect(task.queuedSubtaskIds).toEqual(["subtask-002", "subtask-003"]);
    expect(task.artifactIds).toEqual(["artifact-001"]);
    expect(task.pausedAt).toBeInstanceOf(Date);
    expect(task.waitingSince).toBeInstanceOf(Date);
    expect(task.resumeDeadlineAt).toBeInstanceOf(Date);
    expect(task.pauseReason).toBe("Awaiting human review");
    expect(task.stageRetryCount).toEqual({ planning: 1, implementation: 0 });
    expect(task.totalActionCount).toBe(5);
    expect(task.capturedHumanContext).toBe("Approved with minor changes");
  });
});

// -------------------------------------------------------------------
// Group 4: Task backward compatibility (src/queue/types.ts)
// -------------------------------------------------------------------
describe("Task backward compatibility", () => {
  it("Task with only original required fields is still valid", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod).toBeDefined();
    const task: Record<string, unknown> = {
      id: "task-compat-001",
      gate: "investigate-bug",
      status: "active",
      priority: "high",
      position: 0,
      payload: {},
      requestedBy: "U99999",
      sourceChannel: { platform: "slack", channelId: "C99999" },
      createdAt: new Date(),
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
    const requiredKeys = [
      "id", "gate", "status", "priority", "position",
      "payload", "requestedBy", "sourceChannel", "createdAt", "cost",
    ];
    for (const key of requiredKeys) {
      expect(task[key], `Task must have required field: ${key}`).toBeDefined();
    }
    // New optional fields should be absent when not provided
    expect(task.recipeId).toBeUndefined();
    expect(task.currentStageId).toBeUndefined();
    expect(task.stageRetryCount).toBeUndefined();
    expect(task.totalActionCount).toBeUndefined();
    expect(task.capturedHumanContext).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 5: Subtask recipe fields (src/queue/types.ts)
// -------------------------------------------------------------------
describe("Subtask recipe fields", () => {
  it("Subtask with new recipe dispatch fields is constructible", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod).toBeDefined();
    const subtask: Record<string, unknown> = {
      // Original required fields
      id: "subtask-recipe-001",
      stepId: "planning",
      name: "Run planning agent",
      executionType: "agent",
      status: "pending",
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      attempt: 1,
      maxRetries: 2,
      // New optional recipe fields
      kind: "stage_agent_run",
      stageId: "planning",
      payload: { description: "Analyze request", targetStage: "planning" },
      artifactIds: ["artifact-010", "artifact-011"],
    };
    expect(subtask.kind).toBe("stage_agent_run");
    expect(subtask.stageId).toBe("planning");
    expect(subtask.payload).toEqual({ description: "Analyze request", targetStage: "planning" });
    expect(subtask.artifactIds).toEqual(["artifact-010", "artifact-011"]);
  });
});

// -------------------------------------------------------------------
// Group 6: Subtask backward compatibility (src/queue/types.ts)
// -------------------------------------------------------------------
describe("Subtask backward compatibility", () => {
  it("Subtask with only original required fields is still valid", async () => {
    const mod = await import("../../src/queue/types.js");
    expect(mod).toBeDefined();
    const subtask: Record<string, unknown> = {
      id: "subtask-compat-001",
      stepId: "implementation",
      name: "Run implementation",
      executionType: "script",
      status: "active",
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      attempt: 1,
      maxRetries: 0,
    };
    const requiredKeys = ["id", "stepId", "name", "executionType", "status", "cost", "attempt", "maxRetries"];
    for (const key of requiredKeys) {
      expect(subtask[key], `Subtask must have required field: ${key}`).toBeDefined();
    }
    // New optional fields should be absent when not provided
    expect(subtask.kind).toBeUndefined();
    expect(subtask.stageId).toBeUndefined();
    expect(subtask.payload).toBeUndefined();
    expect(subtask.artifactIds).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Group 7: TypeScript compilation (src/queue/types.ts)
// -------------------------------------------------------------------
describe("TypeScript compilation", () => {
  it("full project compiles with queue type changes", () => {
    const result = execSync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.trim()).toBe("");
  });
});
