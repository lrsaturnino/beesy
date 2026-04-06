/**
 * Deterministic task executor for sequential subtask orchestration.
 *
 * The executor is the core orchestration loop (Layer 4) in the Bees pipeline.
 * It sits between the BullMQ queue worker (which dequeues tasks one at a time)
 * and the subtask dispatcher (which routes each step to agent/script/tool
 * runners).
 *
 * Lifecycle:
 * 1. Reads the gate workflow step list and generates an ordered Subtask array
 * 2. Iterates sequentially through subtasks (never parallel)
 * 3. Manages subtask status transitions: pending -> active -> completed/failed
 * 4. Emits progress events at each transition via optional callback
 * 5. Calls the injected dispatch function for each subtask
 * 6. Accumulates successful step outputs for downstream step consumption
 * 7. Marks the parent task completed or failed based on outcomes
 *
 * The executor contains zero LLM logic -- it is pure orchestration only.
 * The dispatch function is injected as a dependency, not imported directly,
 * following the same dependency injection pattern as {@link RunnerDeps} in
 * the subtask dispatcher.
 *
 * @module executor/task-executor
 */

import type { Task, Subtask, ExecutionType } from "../queue/types.js";
import type { GateConfig, StepDefinition } from "../gates/types.js";
import type { StepContext, StepOutput } from "../runners/types.js";
import { buildStepContext } from "./context-builder.js";
import { createLogger } from "../utils/logger.js";

/** Observable progress event emitted at each subtask lifecycle transition. */
export interface ProgressEvent {
  /** Parent task identifier. */
  taskId: string;
  /** Zero-based index of the current step in the workflow. */
  stepIndex: number;
  /** Total number of steps in the workflow. */
  totalSteps: number;
  /** Human-readable step name. */
  stepName: string;
  /** How the step is executed (agent, script, or tool). */
  executionType: ExecutionType;
  /** Lifecycle transition that triggered this event. */
  status: "started" | "completed" | "failed";
  /** Error message when status is "failed". */
  error?: string;
  /** Elapsed time in milliseconds from activation to completion/failure. */
  duration?: number;
  /** Current execution attempt (1-based). Present during retry-enabled steps. */
  attempt?: number;
}

/** Callback invoked by the executor at each subtask transition. */
export type ProgressCallback = (event: ProgressEvent) => void;

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Dispatch function signature for subtask execution.
 *
 * Matches the `runSubtask` dispatcher signature with `runners` already
 * bound by the caller. The BullMQ worker creates a bound dispatcher:
 * `const dispatch = (subtask, step, context) => runSubtask(subtask, step, context, runners);`
 */
export type DispatchFn = (
  subtask: Subtask,
  step: StepDefinition,
  context: StepContext,
) => Promise<StepOutput>;

/** Zero-initialized cost accumulator for newly created subtasks. */
const ZERO_COST = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
} as const;

/**
 * Generate an ordered array of subtasks from the gate workflow configuration.
 *
 * Each workflow step ID is looked up in the gate step definitions to extract
 * the execution type and behavior. If a step ID is not found in the step
 * definitions, the function throws with a descriptive error.
 *
 * @param task       - The parent task (provides the task ID for subtask ID generation)
 * @param gateConfig - The gate configuration with workflow steps and step definitions
 * @returns An ordered array of subtasks with initial status "pending"
 */
function generateSubtasks(task: Task, gateConfig: GateConfig): Subtask[] {
  return gateConfig.workflow.steps.map((stepId) => {
    const stepDef = gateConfig.steps[stepId];
    if (!stepDef) {
      throw new Error(
        `Step "${stepId}" not found in gate "${gateConfig.gate.id}" step definitions`,
      );
    }

    return {
      id: `${task.id}-${stepId}`,
      stepId,
      name: stepDef.behavior ?? stepId,
      executionType: stepDef.execution.type,
      status: "pending" as const,
      cost: { ...ZERO_COST },
      attempt: 1,
      maxRetries: stepDef.retryPolicy?.maxRetries ?? 0,
    };
  });
}

/**
 * Transition a subtask to "active" and record its start timestamp.
 *
 * Centralizes the activation side-effects that precede every dispatch call,
 * keeping the main loop focused on orchestration flow.
 *
 * @param subtask - The subtask to activate (mutated in place)
 */
function activateSubtask(subtask: Subtask): void {
  subtask.status = "active";
  subtask.startedAt = new Date();
}

/**
 * Transition a subtask to "completed" and capture its output.
 *
 * Populates the subtask with the runner's output text and file list,
 * and records the completion timestamp.
 *
 * @param subtask - The subtask to complete (mutated in place)
 * @param output  - Runner output to capture on the subtask
 */
function completeSubtask(subtask: Subtask, output: StepOutput): void {
  subtask.status = "completed";
  subtask.completedAt = new Date();
  subtask.output = output.output;
  subtask.outputFiles = output.outputFiles;
}

/**
 * Transition a subtask to "failed" and record the error.
 *
 * @param subtask      - The subtask to mark as failed (mutated in place)
 * @param errorMessage - Descriptive error string for diagnosis
 */
function failSubtask(subtask: Subtask, errorMessage: string): void {
  subtask.status = "failed";
  subtask.error = errorMessage;
  subtask.completedAt = new Date();
}

/**
 * Reset a subtask for a retry attempt after a failure.
 *
 * Clears the failure state (error, timestamps) and increments the attempt
 * counter so the subtask can be re-dispatched. The cost accumulator is
 * reset to zero since each attempt starts fresh.
 *
 * @param subtask - The failed subtask to reset for retry (mutated in place)
 */
function resetSubtaskForRetry(subtask: Subtask): void {
  subtask.status = "pending";
  subtask.error = undefined;
  subtask.startedAt = undefined;
  subtask.completedAt = undefined;
  subtask.cost = { ...ZERO_COST };
  subtask.attempt += 1;
}

/**
 * Finalize a task as failed after a subtask error.
 *
 * Sets the task status, records the error with the failing step ID
 * for traceability, and timestamps the completion.
 *
 * @param task         - The parent task (mutated in place)
 * @param stepId       - Step ID that caused the failure
 * @param errorMessage - Error string from the failing subtask
 */
function failTask(task: Task, stepId: string, errorMessage: string): void {
  task.status = "failed";
  task.error = `Subtask "${stepId}" failed: ${errorMessage}`;
  task.completedAt = new Date();
}

/**
 * Compute elapsed time in milliseconds between subtask activation and
 * completion/failure. Returns undefined when either timestamp is absent
 * (e.g., for "started" events where completedAt does not yet exist).
 *
 * @param subtask - The subtask whose timestamps to inspect
 * @returns Elapsed milliseconds, or undefined if timestamps are incomplete
 */
function computeSubtaskDuration(subtask: Subtask): number | undefined {
  if (subtask.completedAt && subtask.startedAt) {
    return subtask.completedAt.getTime() - subtask.startedAt.getTime();
  }
  return undefined;
}

/**
 * Fire a progress event through the callback with error isolation.
 *
 * Wraps every onProgress invocation in a try/catch so that a broken
 * callback never crashes the executor loop. Errors are logged with
 * enough context for diagnosis (task ID, step index, event status).
 *
 * @param onProgress - The callback to invoke (may be undefined, in which case this is a no-op)
 * @param event      - The progress event to emit
 */
function emitProgress(
  onProgress: ProgressCallback | undefined,
  event: ProgressEvent,
): void {
  if (!onProgress) return;
  try {
    onProgress(event);
  } catch (err) {
    logger.error("Progress callback failed", {
      taskId: event.taskId,
      stepIndex: event.stepIndex,
      status: event.status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Possible outcomes from subtask failure handling within the retry loop. */
type FailureAction = "retry" | "abort";

/**
 * Handle a subtask failure by recording the error, emitting a progress event,
 * and deciding whether to retry or abort.
 *
 * Centralizes the failure handling logic shared by both the error-field path
 * and the thrown-exception path, eliminating duplication in the retry loop.
 *
 * When retries remain (`attempt <= maxRetries`), the subtask is reset for
 * another attempt and the function returns "retry". Otherwise it finalizes
 * the task as failed and returns "abort".
 *
 * @param task         - The parent task (failed when retries are exhausted)
 * @param subtask      - The subtask that failed (mutated in place)
 * @param errorMessage - Descriptive error from the dispatch result or exception
 * @param baseEvent    - Base progress event fields for this attempt
 * @param onProgress   - Optional progress callback
 * @returns "retry" if the subtask should be re-dispatched, "abort" if retries
 *          are exhausted and the task has been finalized as failed
 */
function handleSubtaskFailure(
  task: Task,
  subtask: Subtask,
  errorMessage: string,
  baseEvent: Omit<ProgressEvent, "status" | "error" | "duration">,
  onProgress: ProgressCallback | undefined,
): FailureAction {
  failSubtask(subtask, errorMessage);
  emitProgress(onProgress, {
    ...baseEvent,
    status: "failed",
    error: errorMessage,
    duration: computeSubtaskDuration(subtask),
  });

  if (subtask.attempt <= subtask.maxRetries) {
    logger.info("Retrying subtask", {
      taskId: task.id,
      subtaskId: subtask.id,
      attempt: subtask.attempt,
      maxRetries: subtask.maxRetries,
    });
    resetSubtaskForRetry(subtask);
    return "retry";
  }

  failTask(task, subtask.stepId, errorMessage);
  logger.error("Subtask failed permanently", {
    taskId: task.id,
    subtaskId: subtask.id,
    error: errorMessage,
  });
  return "abort";
}

/**
 * Execute a task by iterating through its gate workflow steps sequentially.
 *
 * The task object is mutated in place (mutable state carrier pattern).
 * The returned task is the same object reference as the input, updated
 * with subtask results, status transitions, and timestamps.
 *
 * Each successfully completed step's output is accumulated and passed to
 * subsequent steps via {@link buildStepContext}, enabling multi-step data
 * flow. Failed steps are excluded from the accumulated outputs map.
 *
 * On failure, the executor stops iteration immediately. The failed subtask
 * receives an error field, remaining subtasks stay in "pending" status,
 * and the task is marked "failed".
 *
 * @param task       - The task to execute (mutated in place)
 * @param gateConfig - The gate configuration defining the workflow
 * @param dispatch   - Injected dispatch function for subtask execution
 * @param onProgress - Optional callback invoked at each subtask lifecycle
 *                     transition (started, completed, failed). Errors thrown
 *                     by this callback are caught and logged, never propagated.
 * @returns The same task reference, updated with execution results
 */
export async function executeTask(
  task: Task,
  gateConfig: GateConfig,
  dispatch: DispatchFn,
  onProgress?: ProgressCallback,
): Promise<Task> {
  const subtasks = generateSubtasks(task, gateConfig);
  task.subtasks = subtasks;
  task.currentSubtask = 0;

  // Empty workflow: mark completed immediately with timestamps
  if (subtasks.length === 0) {
    task.status = "completed";
    task.startedAt = new Date();
    task.completedAt = new Date();
    logger.info("Task completed with empty workflow", {
      taskId: task.id,
      gateId: gateConfig.gate.id,
    });
    return task;
  }

  task.status = "active";
  task.startedAt = new Date();
  logger.info("Task execution started", {
    taskId: task.id,
    gateId: gateConfig.gate.id,
    subtaskCount: subtasks.length,
  });

  const accumulatedOutputs: Record<string, StepOutput> = {};

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    task.currentSubtask = i;
    const stepDef = gateConfig.steps[subtask.stepId];

    let subtaskCompleted = false;

    // Safety guard: total attempts bounded by maxRetries + 1
    while (subtask.attempt <= subtask.maxRetries + 1) {
      const baseEvent: Omit<ProgressEvent, "status" | "error" | "duration"> = {
        taskId: task.id,
        stepIndex: i,
        totalSteps: subtasks.length,
        stepName: subtask.name,
        executionType: subtask.executionType,
        attempt: subtask.attempt,
      };

      activateSubtask(subtask);
      emitProgress(onProgress, { ...baseEvent, status: "started" });

      // Context rebuilt each attempt so retries receive current accumulated state
      const context = buildStepContext(task, gateConfig, subtask.stepId, accumulatedOutputs);

      logger.debug("Dispatching subtask", {
        taskId: task.id,
        subtaskId: subtask.id,
        stepId: subtask.stepId,
        executionType: subtask.executionType,
        attempt: subtask.attempt,
        maxRetries: subtask.maxRetries,
      });

      try {
        const output = await dispatch(subtask, stepDef, context);

        if (output.error) {
          const action = handleSubtaskFailure(task, subtask, output.error, baseEvent, onProgress);
          if (action === "retry") continue;
          return task;
        }

        completeSubtask(subtask, output);
        accumulatedOutputs[subtask.stepId] = output;
        emitProgress(onProgress, {
          ...baseEvent,
          status: "completed",
          duration: computeSubtaskDuration(subtask),
        });

        logger.debug("Subtask completed", {
          taskId: task.id,
          subtaskId: subtask.id,
          stepId: subtask.stepId,
        });

        subtaskCompleted = true;
        break;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const action = handleSubtaskFailure(task, subtask, errorMessage, baseEvent, onProgress);
        if (action === "retry") continue;
        return task;
      }
    }

    // Safety guard: if the while condition terminated the loop without a
    // successful dispatch or an explicit task failure, fail gracefully.
    if (!subtaskCompleted) {
      failTask(task, subtask.stepId, subtask.error ?? "Retry loop exhausted");
      return task;
    }
  }

  task.status = "completed";
  task.completedAt = new Date();
  logger.info("Task completed successfully", {
    taskId: task.id,
    gateId: gateConfig.gate.id,
    subtaskCount: subtasks.length,
  });

  return task;
}
