/**
 * Task and subtask domain types for the queue system.
 *
 * Defines the core data model for tasks flowing through the Bees platform:
 * lifecycle statuses, priority levels, execution types, subtask dispatch
 * kinds, cost tracking, and the Task/Subtask structures that represent
 * queued work for both gate-centric and recipe-driven workflows.
 *
 * @module queue/types
 */

import type { ChannelRef } from "../adapters/types.js";

/** Valid task lifecycle statuses. */
export const TASK_STATUSES = [
  "queued",
  "active",
  "paused",
  "waiting",
  "completed",
  "failed",
  "aborted",
] as const;

/** Task lifecycle status union type. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Valid subtask lifecycle statuses. */
export const SUBTASK_STATUSES = [
  "pending",
  "active",
  "needs_input",
  "completed",
  "failed",
  "skipped",
] as const;

/** Subtask lifecycle status union type. */
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

/** Valid task priority levels ordered from highest to lowest urgency. */
export const TASK_PRIORITIES = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

/** Task priority level union type. */
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Valid execution strategies for a subtask step. */
export const EXECUTION_TYPES = ["agent", "script", "tool"] as const;

/** Execution strategy union type for a subtask step. */
export type ExecutionType = (typeof EXECUTION_TYPES)[number];

/** Valid subtask kind identifiers for the queue dispatch system. */
export const SUBTASK_KINDS = [
  "orchestrator_eval",
  "stage_agent_run",
  "resume_after_input",
  "script_run",
] as const;

/** Subtask kind union type derived from {@link SUBTASK_KINDS}. */
export type SubtaskKind = (typeof SUBTASK_KINDS)[number];

/** Tracks token usage and estimated cost for a task or subtask. */
export interface CostAccumulator {
  /** Total tokens consumed (input + output). */
  totalTokens: number;
  /** Tokens sent to the model. */
  inputTokens: number;
  /** Tokens received from the model. */
  outputTokens: number;
  /** Estimated cost in USD. */
  estimatedCostUsd: number;
}

/** A single step within a task workflow execution. */
export interface Subtask {
  /** Unique subtask identifier. */
  id: string;
  /** Reference to the step definition in the gate config. */
  stepId: string;
  /** Human-readable step name. */
  name: string;
  /** How the step is executed (agent, script, or tool). */
  executionType: ExecutionType;
  /** Current lifecycle status. */
  status: SubtaskStatus;
  /** Accumulated cost for this subtask. */
  cost: CostAccumulator;
  /** Current execution attempt (1-based, incremented on retry). */
  attempt: number;
  /** Maximum number of retries from the step's retry policy (0 = no retries). */
  maxRetries: number;
  /** When execution started (set on activation). */
  startedAt?: Date;
  /** When execution completed or failed. */
  completedAt?: Date;
  /** Text output produced by execution. */
  output?: string;
  /** File paths produced by execution. */
  outputFiles?: string[];
  /** Error message if execution failed. */
  error?: string;
  /** Human input received at a checkpoint. */
  humanInput?: string;

  // -- Recipe-oriented dispatch fields -----------------------------------------

  /** Dispatch kind for the worker loop (undefined for gate-centric subtasks). */
  kind?: SubtaskKind;
  /** Recipe stage this subtask belongs to. */
  stageId?: string;
  /** Resolved input data for execution. */
  payload?: Record<string, unknown>;
  /** Artifact identifiers produced by this subtask. */
  artifactIds?: string[];
}

/** A queued unit of work routed through a gate workflow. */
export interface Task {
  /** Unique task identifier. */
  id: string;
  /** Gate that handles this task. */
  gate: string;
  /** Current lifecycle status. */
  status: TaskStatus;
  /** Execution priority. */
  priority: TaskPriority;
  /** Position in the queue. */
  position: number;
  /** User-provided input data. */
  payload: Record<string, unknown>;
  /** User identifier who requested the task. */
  requestedBy: string;
  /** Channel to route replies back to. */
  sourceChannel: ChannelRef;
  /** When the task was created. */
  createdAt: Date;
  /** Accumulated cost across all subtasks. */
  cost: CostAccumulator;
  /** When execution started (set on activation). */
  startedAt?: Date;
  /** When execution completed or failed. */
  completedAt?: Date;
  /** Cron job identifier for scheduled tasks. */
  cronJobId?: string;
  /** Ordered list of subtasks in the workflow. */
  subtasks?: Subtask[];
  /** Index of the currently executing subtask. */
  currentSubtask?: number;
  /** Filesystem path for the task workspace. */
  workspacePath?: string;
  /** Error message if task failed. */
  error?: string;

  // -- Delivery metadata fields -----------------------------------------------

  /** Git branch name for this task's workspace. */
  branchName?: string;
  /** Path to the base git repository. */
  repoPath?: string;
  /** URL of the created or updated pull request. */
  prUrl?: string;
  /** Numeric pull request identifier. */
  prNumber?: number;
  /** Per-step delivery completion tracking. */
  deliveryStatus?: Record<string, "completed" | "pending" | "failed">;

  // -- Recipe-oriented orchestration fields ------------------------------------

  /** Recipe that drives this task (undefined for gate-centric tasks). */
  recipeId?: string;
  /** Active recipe stage identifier. */
  currentStageId?: string;
  /** Currently executing subtask identifier. */
  activeSubtaskId?: string;
  /** Ordered queue of pending subtask identifiers. */
  queuedSubtaskIds?: string[];
  /** Artifact identifiers produced during this task. */
  artifactIds?: string[];

  /** When the task was paused. */
  pausedAt?: Date;
  /** When the task entered the waiting state. */
  waitingSince?: Date;
  /** Deadline for resume before the timeout action fires. */
  resumeDeadlineAt?: Date;
  /** Human-readable reason for the pause. */
  pauseReason?: string;
  /** Input captured during a resume from human interaction. */
  capturedHumanContext?: string;

  /** Per-stage retry counters keyed by stage identifier. */
  stageRetryCount?: Record<string, number>;
  /** Running count of orchestrator decisions for this task. */
  totalActionCount?: number;
}
