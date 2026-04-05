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
 * 4. Calls the injected dispatch function for each subtask
 * 5. Marks the parent task completed or failed based on outcomes
 *
 * The executor contains zero LLM logic -- it is pure orchestration only.
 * The dispatch function is injected as a dependency, not imported directly,
 * following the same dependency injection pattern as {@link RunnerDeps} in
 * the subtask dispatcher.
 *
 * @module executor/task-executor
 */

import type { Task, Subtask } from "../queue/types.js";
import type { GateConfig, StepDefinition } from "../gates/types.js";
import type { StepContext, StepOutput } from "../runners/types.js";
import { buildStepContext } from "./context-builder.js";
import { createLogger } from "../utils/logger.js";

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
 * Execute a task by iterating through its gate workflow steps sequentially.
 *
 * The task object is mutated in place (mutable state carrier pattern).
 * The returned task is the same object reference as the input, updated
 * with subtask results, status transitions, and timestamps.
 *
 * On failure, the executor stops iteration immediately. The failed subtask
 * receives an error field, remaining subtasks stay in "pending" status,
 * and the task is marked "failed". No retry logic is applied in TD-1.
 *
 * @param task       - The task to execute (mutated in place)
 * @param gateConfig - The gate configuration defining the workflow
 * @param dispatch   - Injected dispatch function for subtask execution
 * @returns The same task reference, updated with execution results
 */
export async function executeTask(
  task: Task,
  gateConfig: GateConfig,
  dispatch: DispatchFn,
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

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    task.currentSubtask = i;

    activateSubtask(subtask);

    const context = buildStepContext(task, gateConfig, subtask.stepId);
    const stepDef = gateConfig.steps[subtask.stepId];

    logger.debug("Executing subtask", {
      taskId: task.id,
      subtaskId: subtask.id,
      stepId: subtask.stepId,
      executionType: subtask.executionType,
    });

    try {
      const output = await dispatch(subtask, stepDef, context);

      // Non-thrown failure signaled via StepOutput.error field
      if (output.error) {
        failSubtask(subtask, output.error);
        failTask(task, subtask.stepId, output.error);
        logger.error("Subtask failed with error in output", {
          taskId: task.id,
          subtaskId: subtask.id,
          error: output.error,
        });
        return task;
      }

      completeSubtask(subtask, output);
      logger.debug("Subtask completed", {
        taskId: task.id,
        subtaskId: subtask.id,
        stepId: subtask.stepId,
      });
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      failSubtask(subtask, errorMessage);
      failTask(task, subtask.stepId, errorMessage);
      logger.error("Subtask threw an exception", {
        taskId: task.id,
        subtaskId: subtask.id,
        error: errorMessage,
      });
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
