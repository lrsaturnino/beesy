/**
 * Deterministic worker loop for the recipe-driven orchestrator runtime.
 *
 * Central execution engine that dequeues subtasks, dispatches to the correct
 * handler, persists results, and triggers the next orchestrator evaluation.
 * The worker has zero decision logic -- all branching is determined by the
 * orchestrator agent's structured decisions.
 *
 * Serial per-task: one active subtask at a time. Every subtask result is
 * persisted before the next subtask starts. The journal is always written
 * before task state persistence so it remains the authoritative record for
 * recovery.
 *
 * Composes: task-state, journal, orchestrator-context, decision-validator,
 * stage-agent-handler. Delegates stage execution to stage-agent-handler.
 * Extended by pause/resume controller and recovery module.
 *
 * @module runtime/worker
 */

import { readFileSync } from "node:fs";
import type { Task } from "../queue/types.js";
import type {
  RecipeConfig,
  OrchestratorDecision,
} from "../recipes/types.js";
import type { AgentConfig, StepContext } from "../runners/types.js";
import { resolveAgentBackend } from "../runners/registry.js";
import {
  persistTask,
  enqueueSubtask,
  dequeueNext,
  markSubtaskActive,
  markSubtaskComplete,
  markSubtaskFailed,
} from "./task-state.js";
import { appendJournalEntry, readJournal } from "./journal.js";
import { buildOrchestratorContext } from "./orchestrator-context.js";
import { validateDecision } from "./decision-validator.js";
import { handleStageAgentRun } from "./stage-agent-handler.js";
import { DEFAULT_RESUME_TIMEOUT_MS } from "./pause-controller.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum consecutive invalid decisions before the worker fails the task.
 * Prevents infinite re-invocation loops when the orchestrator persistently
 * returns invalid decisions.
 */
const MAX_CONSECUTIVE_REJECTIONS = 5;

/** Task statuses that terminate the main loop. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "paused"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective current stage for a task.
 *
 * Returns the task's currentStageId if set, otherwise falls back to the
 * recipe's start_stage. Centralizes this fallback logic to avoid repeating
 * the same null-coalescing expression across multiple call sites.
 *
 * @param task   - The task whose current stage to resolve
 * @param recipe - Recipe configuration providing the start_stage fallback
 * @returns The effective current stage identifier
 */
function effectiveStage(task: Task, recipe: RecipeConfig): string {
  return task.currentStageId ?? recipe.start_stage;
}

/**
 * Read the orchestrator role file content from disk.
 *
 * Uses synchronous read to match the journal module's synchronous I/O
 * pattern, keeping the ordering guarantee simple: role content is available
 * before any async operations begin.
 *
 * @param rolePath - Filesystem path to the orchestrator role file
 * @returns The role file content as a UTF-8 string
 * @throws Error if the file does not exist or cannot be read
 */
function readRoleFile(rolePath: string): string {
  try {
    return readFileSync(rolePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Failed to read orchestrator role file: ${rolePath} (${code ?? "unknown error"})`,
    );
  }
}

/**
 * Summarize recent journal entries into a text block for orchestrator context.
 *
 * Reads the full journal and produces a condensed summary of the most recent
 * events. Limits output to the last 20 entries to keep the orchestrator prompt
 * within reasonable token bounds.
 *
 * @param runsDir - Base directory containing all task run directories
 * @param taskId  - Identifier of the task whose journal to summarize
 * @returns A text summary of recent journal events
 */
function summarizeJournal(runsDir: string, taskId: string): string {
  const entries = readJournal(runsDir, taskId);
  if (entries.length === 0) {
    return "No journal entries yet.";
  }

  const recent = entries.slice(-20);
  const lines = recent.map((e) => {
    const base = `[${e.timestamp}] ${e.type}`;
    if (e.type === "orchestrator_decision" && e.action) {
      return `${base}: action=${e.action}${e.target_stage ? `, target=${e.target_stage}` : ""}`;
    }
    if (e.type === "decision_rejected" && e.rejectionReason) {
      return `${base}: ${e.rejectionReason}`;
    }
    if (
      (e.type === "subtask_started" || e.type === "subtask_completed") &&
      e.subtaskId
    ) {
      return `${base}: subtask=${e.subtaskId}`;
    }
    if (e.type === "subtask_failed" && e.subtaskId) {
      return `${base}: subtask=${e.subtaskId}, error=${e.error ?? "unknown"}`;
    }
    return base;
  });

  return lines.join("\n");
}

/**
 * Render the orchestrator prompt in the # Role / # Task / # Output format.
 *
 * Produces a three-section markdown prompt consumed by the orchestrator agent:
 * - # Role: behavioral instructions from the role file
 * - # Task: current stage context, budget tracking, journal summary
 * - # Output: required JSON decision schema
 *
 * @param roleContent - Content of the orchestrator role file
 * @param context     - Assembled orchestrator context from buildOrchestratorContext
 * @param rejectionReason - Optional rejection reason from a previous invalid decision
 * @returns The fully rendered prompt string
 */
function renderOrchestratorPrompt(
  roleContent: string,
  context: ReturnType<typeof buildOrchestratorContext>,
  rejectionReason?: string,
): string {
  const sections: string[] = [];

  // # Role section
  sections.push(`# Role\n\n${roleContent}`);

  // # Task section
  let taskSection = `# Task\n\nCurrent Stage: ${context.currentStageId}`;
  taskSection += `\nObjective: ${context.stageDefinition.objective}`;
  taskSection += `\nAllowed Transitions: ${context.allowedTransitions.length > 0 ? context.allowedTransitions.join(", ") : "none (terminal stage)"}`;
  taskSection += `\n\nBudget:`;
  taskSection += `\n- Stage retries used: ${JSON.stringify(context.retryCounts)}`;
  taskSection += `\n- Max stage retries: ${context.maxStageRetries}`;
  taskSection += `\n- Total actions used: ${context.totalActionCount}`;
  taskSection += `\n- Max total actions: ${context.maxTotalActions}`;

  if (context.latestStageOutput) {
    taskSection += `\n\nLatest Stage Output:\n${context.latestStageOutput}`;
  }

  if (context.inputPatch) {
    taskSection += `\n\nInput Patch: ${JSON.stringify(context.inputPatch)}`;
  }

  if (rejectionReason) {
    taskSection += `\n\nPrevious Decision Rejected: ${rejectionReason}`;
    taskSection += `\nPlease provide a valid decision.`;
  }

  taskSection += `\n\nJournal Summary:\n${context.journalSummary}`;

  sections.push(taskSection);

  // # Output section
  let outputSection = `# Output\n\nReturn a single JSON object with this schema:`;
  outputSection += `\n\`\`\`json`;
  outputSection += `\n{`;
  outputSection += `\n  "action": "run_stage_agent" | "pause_for_input" | "finish_run" | "fail_run",`;
  outputSection += `\n  "target_stage": "stage_id (required for run_stage_agent and pause_for_input)",`;
  outputSection += `\n  "input_patch": { "key": "value (optional, merged into stage inputs)" },`;
  outputSection += `\n  "state_patch": { "key": "value (optional, merged into run state)" },`;
  outputSection += `\n  "reason": "explanation for this decision"`;
  outputSection += `\n}`;
  outputSection += `\n\`\`\``;

  sections.push(outputSection);

  return sections.join("\n\n");
}

/**
 * Parse the backend output as a JSON orchestrator decision.
 *
 * Extracts the JSON from the output string, handling cases where the output
 * might contain markdown code fences or extra whitespace around the JSON.
 *
 * @param output - Raw output string from the backend
 * @returns The parsed OrchestratorDecision
 * @throws Error if the output cannot be parsed as valid JSON
 */
function parseDecision(output: string): OrchestratorDecision {
  let text = output.trim();

  // Strip markdown code fences if present
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    text = jsonBlockMatch[1].trim();
  }

  try {
    return JSON.parse(text) as OrchestratorDecision;
  } catch {
    throw new Error(
      `Failed to parse orchestrator decision as JSON: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Build a recipe variant for validation that includes the current stage in
 * its own allowed_transitions. This permits the orchestrator to re-run the
 * current stage (retry/re-execute) without a transition legality violation,
 * while still enforcing all other validation rules (budget, structure, etc.).
 *
 * Returns a shallow copy of the recipe with only the current stage's
 * allowed_transitions modified. All other recipe data is shared by reference.
 *
 * @param recipe       - Original recipe configuration
 * @param currentStage - Current stage identifier to allow self-transition
 * @returns Recipe with self-transition added for the current stage
 */
function buildValidationRecipe(
  recipe: RecipeConfig,
  currentStage: string,
): RecipeConfig {
  const stageDef = recipe.stages[currentStage];
  if (!stageDef) return recipe;

  // If current stage already allows self-transition, no modification needed
  if (stageDef.allowed_transitions.includes(currentStage)) return recipe;

  return {
    ...recipe,
    stages: {
      ...recipe.stages,
      [currentStage]: {
        ...stageDef,
        allowed_transitions: [...stageDef.allowed_transitions, currentStage],
      },
    },
  };
}

/**
 * Collect all output labels that should be considered completed for validation.
 *
 * Combines three sources:
 * 1. artifact_registered journal entries (real stage-agent-handler writes these)
 * 2. Output labels from stages with completed stage_agent_run subtasks
 * 3. Output labels from stages that were never entered (their outputs are not
 *    required since the orchestrator chose not to run them)
 *
 * The worker delegates output completeness judgment to the orchestrator agent.
 * If the orchestrator decides finish_run, the worker trusts that decision and
 * only validates structural/transition/budget constraints.
 *
 * @param task    - Parent task with subtasks array
 * @param recipe  - Recipe configuration with stage output definitions
 * @param runsDir - Base directory for task run data
 * @returns Set of output labels considered completed
 */
function collectCompletedOutputLabels(
  task: Task,
  recipe: RecipeConfig,
  runsDir: string,
): Set<string> {
  const labels = new Set<string>();

  // Source 1: artifact_registered journal entries
  const journalEntries = readJournal(runsDir, task.id);
  for (const entry of journalEntries) {
    if (entry.type === "artifact_registered" && typeof entry.label === "string") {
      labels.add(entry.label);
    }
  }

  // Source 2: output labels from stages with completed stage_agent_run subtasks
  const completedStageIds = new Set<string>();
  for (const subtask of task.subtasks ?? []) {
    if (
      subtask.kind === "stage_agent_run" &&
      subtask.status === "completed" &&
      subtask.stageId
    ) {
      completedStageIds.add(subtask.stageId);
    }
  }

  for (const stageId of completedStageIds) {
    const stageDef = recipe.stages[stageId];
    if (stageDef) {
      for (const output of stageDef.outputs) {
        labels.add(output.label);
      }
    }
  }

  // Source 3: output labels from stages never entered (not required)
  for (const [stageId, stageDef] of Object.entries(recipe.stages)) {
    if (!completedStageIds.has(stageId)) {
      // Check if this stage had any stage_agent_run subtasks at all (even failed)
      const hasAnyRun = (task.subtasks ?? []).some(
        (s) => s.kind === "stage_agent_run" && s.stageId === stageId,
      );
      if (!hasAnyRun) {
        // Stage was never entered, its outputs are not required
        for (const output of stageDef.outputs) {
          labels.add(output.label);
        }
      }
    }
  }

  return labels;
}

/**
 * Handle an orchestrator_eval subtask.
 *
 * Assembles context, renders the prompt, invokes the CLI backend, parses and
 * validates the decision, and applies or rejects it. On invalid decisions,
 * re-invokes the orchestrator within the same subtask up to
 * MAX_CONSECUTIVE_REJECTIONS times.
 *
 * @param task      - Parent task being executed
 * @param subtaskId - Identifier of the orchestrator_eval subtask
 * @param recipe    - Recipe configuration
 * @param runsDir   - Base directory for task run data
 */
async function handleOrchestratorEval(
  task: Task,
  subtaskId: string,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<void> {
  const roleContent = readRoleFile(recipe.orchestrator.role);
  const orch = recipe.orchestrator;

  let rejectionReason: string | undefined;
  let consecutiveRejections = 0;

  while (consecutiveRejections < MAX_CONSECUTIVE_REJECTIONS) {
    const journalSummary = summarizeJournal(runsDir, task.id);

    // Find the latest stage_agent_run output for context
    const subtask = task.subtasks?.find((s) => s.id === subtaskId);
    const latestStageOutput = findLatestStageOutput(task);
    const inputPatch = subtask?.payload as Record<string, unknown> | undefined;

    const context = buildOrchestratorContext(
      task,
      recipe,
      latestStageOutput,
      inputPatch,
      journalSummary,
    );

    const prompt = renderOrchestratorPrompt(roleContent, context, rejectionReason);

    // Build agent config and invoke the backend
    const agentConfig: AgentConfig = {
      model: orch.model,
      tools: [],
      timeoutMs: orch.timeout_ms,
      backend: orch.backend,
      effort: orch.effort,
      systemPrompt: prompt,
    };

    const stepContext: StepContext = {
      taskId: task.id,
      taskPayload: task.payload,
      gateId: recipe.id,
      stepId: effectiveStage(task, recipe),
      priorOutputs: {},
    };

    const backend = resolveAgentBackend(agentConfig);
    const stepOutput = await backend.run(agentConfig, stepContext);

    // Parse the decision from the backend output. On parse failure, record the
    // raw output for debugging and re-invoke the orchestrator with the error.
    let decision: OrchestratorDecision;
    try {
      decision = parseDecision(stepOutput.output);
    } catch (err: unknown) {
      const parseError = err instanceof Error ? err.message : String(err);
      const errorMsg = `${parseError} (task=${task.id}, subtask=${subtaskId})`;
      appendJournalEntry(runsDir, task.id, {
        type: "decision_rejected",
        subtaskId,
        rejectionReason: errorMsg,
        rawOutput: stepOutput.output.slice(0, 500),
      });
      rejectionReason = errorMsg;
      consecutiveRejections++;
      continue;
    }

    // Journal the decision before applying
    appendJournalEntry(runsDir, task.id, {
      type: "orchestrator_decision",
      subtaskId,
      action: decision.action,
      target_stage: decision.target_stage,
      input_patch: decision.input_patch,
      state_patch: decision.state_patch,
      reason: decision.reason,
    });

    // Collect completed output labels from stages with completed stage_agent_run
    // subtasks and from artifact_registered journal entries. The union of both
    // sources ensures correct tracking whether the stage handler is real or mocked.
    const completedOutputLabels = collectCompletedOutputLabels(
      task,
      recipe,
      runsDir,
    );

    // Build a validation-scoped recipe that includes the current stage in its
    // own allowed_transitions. This permits the orchestrator to re-run the
    // current stage (retry) without a transition legality violation.
    const currentStage = effectiveStage(task, recipe);
    const validationRecipe = buildValidationRecipe(recipe, currentStage);

    // Validate the decision against recipe policy
    const validation = validateDecision(
      decision,
      validationRecipe,
      currentStage,
      task.stageRetryCount ?? {},
      task.totalActionCount ?? 0,
      completedOutputLabels,
    );

    if (!validation.valid) {
      appendJournalEntry(runsDir, task.id, {
        type: "decision_rejected",
        subtaskId,
        rejectionReason: validation.reason,
        decision,
      });
      rejectionReason = validation.reason;
      consecutiveRejections++;
      continue;
    }

    // Valid decision: apply it and exit the retry loop
    await applyDecision(task, decision, recipe, runsDir);
    await markSubtaskComplete(runsDir, task, subtaskId);

    appendJournalEntry(runsDir, task.id, {
      type: "subtask_completed",
      subtaskId,
      kind: "orchestrator_eval",
    });

    return;
  }

  // Exhausted rejection budget -- include task and subtask identifiers for debugging
  const errorMsg =
    `Orchestrator exceeded ${MAX_CONSECUTIVE_REJECTIONS} consecutive invalid decisions` +
    ` (task=${task.id}, subtask=${subtaskId})`;
  task.status = "failed";
  task.error = errorMsg;
  task.completedAt = new Date();

  await markSubtaskFailed(runsDir, task, subtaskId, errorMsg);
  appendJournalEntry(runsDir, task.id, {
    type: "subtask_failed",
    subtaskId,
    error: errorMsg,
  });
  appendJournalEntry(runsDir, task.id, {
    type: "task_failed",
    reason: errorMsg,
  });
}

/**
 * Find the output from the most recently completed stage_agent_run subtask.
 *
 * Scans the task's subtasks array in reverse order and returns the output
 * field of the first completed stage_agent_run subtask found.
 *
 * @param task - Parent task with subtasks array
 * @returns The latest stage output string, or null if none found
 */
function findLatestStageOutput(task: Task): string | null {
  if (!task.subtasks) return null;

  for (let i = task.subtasks.length - 1; i >= 0; i--) {
    const s = task.subtasks[i];
    if (s.kind === "stage_agent_run" && s.status === "completed" && s.output) {
      return s.output;
    }
  }

  return null;
}

/**
 * Apply a validated orchestrator decision to the task state.
 *
 * Dispatches on the decision action to perform the appropriate state transition:
 * - run_stage_agent: update stage, increment counters, enqueue stage_agent_run
 * - finish_run: mark task completed
 * - fail_run: mark task failed
 * - pause_for_input: mark task paused
 *
 * @param task     - Parent task (mutated in place)
 * @param decision - The validated orchestrator decision
 * @param recipe   - Recipe configuration
 * @param runsDir  - Base directory for task run data
 */
async function applyDecision(
  task: Task,
  decision: OrchestratorDecision,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<void> {
  switch (decision.action) {
    case "run_stage_agent": {
      const targetStage = decision.target_stage!;

      // Update current stage
      task.currentStageId = targetStage;

      // Increment stage retry count
      if (!task.stageRetryCount) task.stageRetryCount = {};
      task.stageRetryCount[targetStage] =
        (task.stageRetryCount[targetStage] ?? 0) + 1;

      // Increment total action count
      task.totalActionCount = (task.totalActionCount ?? 0) + 1;

      // Apply state_patch if present
      if (decision.state_patch) {
        Object.assign(task.payload, decision.state_patch);
      }

      // Enqueue a stage_agent_run subtask for the target stage
      await enqueueSubtask(runsDir, task, {
        kind: "stage_agent_run",
        stageId: targetStage,
        payload: decision.input_patch,
      });

      appendJournalEntry(runsDir, task.id, {
        type: "subtask_queued",
        subtaskId: task.subtasks![task.subtasks!.length - 1].id,
        kind: "stage_agent_run",
        stageId: targetStage,
      });
      break;
    }

    case "finish_run": {
      task.status = "completed";
      task.completedAt = new Date();

      appendJournalEntry(runsDir, task.id, {
        type: "task_completed",
        reason: decision.reason,
      });
      break;
    }

    case "fail_run": {
      task.status = "failed";
      task.error = decision.reason ?? "Task failed by orchestrator decision";
      task.completedAt = new Date();

      appendJournalEntry(runsDir, task.id, {
        type: "task_failed",
        reason: decision.reason,
      });
      break;
    }

    case "pause_for_input": {
      task.status = "paused";
      task.pausedAt = new Date();
      task.pauseReason = decision.reason ?? "Paused for input";
      task.resumeDeadlineAt = new Date(
        Date.now() + DEFAULT_RESUME_TIMEOUT_MS,
      );

      appendJournalEntry(runsDir, task.id, {
        type: "task_paused",
        reason: decision.reason,
        targetStage: decision.target_stage,
      });
      break;
    }
  }
}

/**
 * Record a stage_agent_run subtask failure and enqueue the next orchestrator eval.
 *
 * Centralizes the failure-handling sequence shared by the caught-exception path
 * and the returned-error path in {@link handleStageAgent}. Marks the subtask
 * failed, journals the failure, and enqueues an orchestrator_eval so the
 * orchestrator can decide how to recover.
 *
 * @param task      - Parent task being executed
 * @param subtaskId - Identifier of the failed subtask
 * @param error     - Error message describing the failure
 * @param recipe    - Recipe configuration
 * @param runsDir   - Base directory for task run data
 */
async function recordStageFailure(
  task: Task,
  subtaskId: string,
  error: string,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<void> {
  await markSubtaskFailed(runsDir, task, subtaskId, error);

  appendJournalEntry(runsDir, task.id, {
    type: "subtask_failed",
    subtaskId,
    kind: "stage_agent_run",
    error,
  });

  await enqueueOrchestratorEval(task, recipe, runsDir);
}

/**
 * Handle a stage_agent_run subtask.
 *
 * Delegates execution to handleStageAgentRun, marks the subtask as completed
 * or failed based on the result, and enqueues the next orchestrator_eval so
 * the orchestrator can decide what happens next.
 *
 * @param task      - Parent task being executed
 * @param subtaskId - Identifier of the stage_agent_run subtask
 * @param recipe    - Recipe configuration
 * @param runsDir   - Base directory for task run data
 */
async function handleStageAgent(
  task: Task,
  subtaskId: string,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<void> {
  const subtask = task.subtasks!.find((s) => s.id === subtaskId)!;

  let result;
  try {
    result = await handleStageAgentRun(task, subtask, recipe, runsDir);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await recordStageFailure(task, subtaskId, errorMsg, recipe, runsDir);
    return;
  }

  if (result.error) {
    await recordStageFailure(task, subtaskId, result.error, recipe, runsDir);
    return;
  }

  // Mark subtask completed with output
  await markSubtaskComplete(runsDir, task, subtaskId, result.output);

  // Store artifact IDs on the subtask
  if (result.artifactIds.length > 0) {
    subtask.artifactIds = result.artifactIds;
    if (!task.artifactIds) task.artifactIds = [];
    task.artifactIds.push(...result.artifactIds);
  }

  appendJournalEntry(runsDir, task.id, {
    type: "subtask_completed",
    subtaskId,
    kind: "stage_agent_run",
    output: result.output?.slice(0, 200),
  });

  // Enqueue the next orchestrator_eval
  await enqueueOrchestratorEval(task, recipe, runsDir);
}

/**
 * Enqueue a new orchestrator_eval subtask for the current stage.
 *
 * Accepts an optional payload that is forwarded as the subtask's resolved
 * input. The resume_after_input handler uses this to pass captured human
 * input so the orchestrator can factor it into its next decision.
 *
 * @param task    - Parent task
 * @param recipe  - Recipe configuration
 * @param runsDir - Base directory for task run data
 * @param payload - Optional input data forwarded to the orchestrator eval
 */
async function enqueueOrchestratorEval(
  task: Task,
  recipe: RecipeConfig,
  runsDir: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const stageId = effectiveStage(task, recipe);
  const newSubtask = await enqueueSubtask(runsDir, task, {
    kind: "orchestrator_eval",
    stageId,
    payload,
  });

  appendJournalEntry(runsDir, task.id, {
    type: "subtask_queued",
    subtaskId: newSubtask.id,
    kind: "orchestrator_eval",
    stageId,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a task through the deterministic worker loop.
 *
 * Entry point for recipe-driven task execution. If no subtasks are queued,
 * enqueues an initial orchestrator_eval for the recipe's start stage. Then
 * processes subtasks one at a time in FIFO order: dequeue, mark active,
 * journal, dispatch by kind, persist.
 *
 * The loop exits when:
 * - No more subtasks are queued (dequeueNext returns null)
 * - Task status transitions to completed, failed, or paused
 *
 * @param task    - The task to execute (mutated in place throughout execution)
 * @param recipe  - Recipe configuration driving the execution
 * @param runsDir - Base directory for task run data persistence
 */
export async function runTask(
  task: Task,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<void> {
  // Initialize: enqueue first orchestrator_eval if no subtasks queued
  if (!task.queuedSubtaskIds || task.queuedSubtaskIds.length === 0) {
    if (!task.currentStageId) {
      task.currentStageId = recipe.start_stage;
    }

    const initialSubtask = await enqueueSubtask(runsDir, task, {
      kind: "orchestrator_eval",
      stageId: task.currentStageId!,
    });

    appendJournalEntry(runsDir, task.id, {
      type: "subtask_queued",
      subtaskId: initialSubtask.id,
      kind: "orchestrator_eval",
      stageId: task.currentStageId,
    });
  }

  // Main loop: process subtasks serially until queue empty or terminal state
  while (!TERMINAL_STATUSES.has(task.status)) {
    const subtask = await dequeueNext(runsDir, task);
    if (!subtask) break;

    // Mark active
    await markSubtaskActive(runsDir, task, subtask.id);

    appendJournalEntry(runsDir, task.id, {
      type: "subtask_started",
      subtaskId: subtask.id,
      kind: subtask.kind,
      stageId: subtask.stageId,
    });

    // Dispatch by subtask kind
    switch (subtask.kind) {
      case "orchestrator_eval":
        await handleOrchestratorEval(task, subtask.id, recipe, runsDir);
        break;

      case "stage_agent_run":
        await handleStageAgent(task, subtask.id, recipe, runsDir);
        break;

      case "resume_after_input": {
        // Restore task to active state and clear all pause-related fields
        task.status = "active";
        task.pausedAt = undefined;
        task.pauseReason = undefined;
        task.resumeDeadlineAt = undefined;
        task.waitingSince = undefined;

        await markSubtaskComplete(runsDir, task, subtask.id);
        appendJournalEntry(runsDir, task.id, {
          type: "subtask_completed",
          subtaskId: subtask.id,
          kind: "resume_after_input",
        });

        // Forward captured human input to the next orchestrator evaluation
        const inputPatch = task.capturedHumanContext
          ? { humanInput: task.capturedHumanContext }
          : undefined;
        await enqueueOrchestratorEval(task, recipe, runsDir, inputPatch);
        break;
      }
    }

    // Persist task state after every subtask
    await persistTask(runsDir, task);
  }
}
