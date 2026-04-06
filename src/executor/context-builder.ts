/**
 * Minimal context builder for step execution.
 *
 * Builds a {@link StepContext} from task metadata, gate configuration, and
 * the current step ID. Each field is mapped directly from the source objects
 * with no transformation or side effects.
 *
 * When an accumulated outputs map is provided, its entries are shallow-copied
 * into `priorOutputs` so each step can read outputs from earlier steps
 * without risking mutation of the shared accumulation map.
 *
 * @module executor/context-builder
 */

import type { Task } from "../queue/types.js";
import type { GateConfig } from "../gates/types.js";
import type { StepContext, StepOutput } from "../runners/types.js";

/**
 * Build step execution context from task state and gate configuration.
 *
 * Maps fields directly from the task and gate config into a {@link StepContext}
 * structure suitable for passing to any runner. The resulting context is a
 * fresh object with no shared references to the input objects beyond the
 * payload reference itself.
 *
 * @param task               - The parent task providing id, payload, and workspace path
 * @param gateConfig         - The gate configuration providing the gate id
 * @param stepId             - The step being executed
 * @param accumulatedOutputs - Outputs from previously completed steps, keyed by step ID
 * @returns A StepContext ready for runner consumption
 */
export function buildStepContext(
  task: Task,
  gateConfig: GateConfig,
  stepId: string,
  accumulatedOutputs: Record<string, StepOutput> = {},
): StepContext {
  return {
    taskId: task.id,
    taskPayload: task.payload,
    gateId: gateConfig.gate.id,
    stepId,
    priorOutputs: { ...accumulatedOutputs },
    ...(task.workspacePath !== undefined && {
      workspacePath: task.workspacePath,
    }),
  };
}
