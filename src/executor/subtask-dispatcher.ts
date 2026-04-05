/**
 * Subtask dispatcher routing step execution to the correct runner.
 *
 * The dispatcher is the central routing function for the execution layer.
 * It receives a subtask, its step definition, and execution context, then
 * delegates to the appropriate runner based on the step's execution type:
 *
 * - `"agent"` steps resolve a backend via the {@link resolveAgentBackend}
 *   registry and call `backend.run()`.
 * - `"script"` steps delegate to the injected `runScript` function.
 * - `"tool"` steps delegate to the injected `runTool` function.
 *
 * Script and tool runners are injected via {@link RunnerDeps} rather than
 * imported directly, keeping the dispatcher decoupled from runner
 * implementations and enabling isolated unit testing.
 *
 * All runners produce a uniform {@link StepOutput} structure regardless
 * of execution type.
 *
 * @module executor/subtask-dispatcher
 */

import type { Subtask } from "../queue/types.js";
import type { StepDefinition } from "../gates/types.js";
import type { StepContext, StepOutput } from "../runners/types.js";
import { resolveAgentBackend } from "../runners/registry.js";

/**
 * Injected runner dependencies for script and tool execution.
 *
 * The dispatcher does not import runner implementations directly -- they
 * are injected via this interface to enable isolated testing and flexible
 * wiring. Each runner accepts execution-specific parameters plus the
 * shared {@link StepContext}, and returns a uniform {@link StepOutput}.
 */
export interface RunnerDeps {
  /**
   * Execute a shell command with optional environment variables.
   *
   * @param command - Shell command string to execute
   * @param env     - Environment variables for the subprocess (undefined if none)
   * @param context - Shared step execution context
   * @returns Step output with captured stdout and produced file paths
   */
  runScript(
    command: string,
    env: Record<string, string> | undefined,
    context: StepContext,
  ): Promise<StepOutput>;

  /**
   * Invoke an in-process tool function by module path and function name.
   *
   * @param module  - Module path containing the tool function
   * @param fn      - Exported function name to invoke
   * @param args    - Arguments to pass to the tool function (undefined if none)
   * @param context - Shared step execution context
   * @returns Step output with the tool's return value and produced file paths
   */
  runTool(
    module: string,
    fn: string,
    args: Record<string, unknown> | undefined,
    context: StepContext,
  ): Promise<StepOutput>;
}

/**
 * Dispatch a subtask to the correct runner based on its step execution type.
 *
 * Routes execution through a discriminated union switch on `step.execution.type`.
 * TypeScript narrows the execution object in each case branch, providing
 * type-safe access to execution-specific fields without assertions.
 *
 * The `_subtask` parameter carries runtime state (status, cost, timing) that
 * is not used for routing but exists in the signature for future extensions
 * such as cost tracking and execution logging.
 *
 * @param _subtask - The subtask being executed (reserved for future use)
 * @param step     - Step definition containing the execution strategy
 * @param context  - Execution context with task payload and prior outputs
 * @param runners  - Injected runner dependencies for script and tool steps
 * @returns Uniform StepOutput from whichever runner handled execution
 */
export async function runSubtask(
  _subtask: Subtask,
  step: StepDefinition,
  context: StepContext,
  runners: RunnerDeps,
): Promise<StepOutput> {
  const execution = step.execution;

  switch (execution.type) {
    case "agent": {
      const backend = resolveAgentBackend(execution.config);
      return backend.run(execution.config, context);
    }

    case "script": {
      return runners.runScript(execution.command, execution.env, context);
    }

    case "tool": {
      return runners.runTool(
        execution.module,
        execution.function,
        execution.args,
        context,
      );
    }

    default: {
      // Exhaustiveness guard: TypeScript assigns `never` when all union members
      // are handled. Adding a new type to StepExecution will produce a compile
      // error here, forcing the developer to add a corresponding case branch.
      const _exhaustive: never = execution;
      throw new Error(
        `Unhandled step execution type: ${(execution as { type: string }).type}`,
      );
    }
  }
}
