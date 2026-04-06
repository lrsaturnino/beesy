/**
 * Stage-agent execution handler for the recipe-driven orchestrator runtime.
 *
 * Processes `stage_agent_run` subtasks by executing four sequential operations:
 * input resolution, prompt rendering, CLI worker invocation, and output
 * normalization. After successful execution, artifacts are stored with durable
 * IDs under `runtime/runs/<task-id>/artifacts/`, compatibility mirrors are
 * created when stage outputs request file mirroring, and journal entries are
 * appended for each registered artifact.
 *
 * Consumed by the deterministic worker loop when dispatching
 * `stage_agent_run` subtasks. Depends on the backend registry for CLI
 * worker resolution and the journal module for artifact registration.
 *
 * @module runtime/stage-agent-handler
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, Subtask } from "../queue/types.js";
import type {
  StageDefinition,
  StageOutput,
  RecipeConfig,
} from "../recipes/types.js";
import type {
  StepOutput,
  AgentConfig,
  StepContext,
} from "../runners/types.js";
import { resolveAgentBackend } from "../runners/registry.js";
import { appendJournalEntry } from "./journal.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Structured result returned by the stage-agent handler after execution. */
export interface StageAgentResult {
  /** Text output from the CLI worker execution. */
  output: string;
  /** Durable artifact identifiers produced during this execution. */
  artifactIds: string[];
  /** Present only when execution failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Traverse a nested object using a dot-separated path expression.
 *
 * Splits the path on `"."` and follows each segment through nested objects.
 * Returns `undefined` when any intermediate segment is missing, is null, or
 * is not an object. Never throws -- callers handle missing values at the
 * application level.
 *
 * @param root    - Root object to traverse
 * @param dotPath - Dot-separated property path (e.g., "task.payload.description")
 * @returns The resolved value, or `undefined` if any segment is unreachable
 */
function resolveSourcePath(
  root: Record<string, unknown>,
  dotPath: string,
): unknown {
  const segments = dotPath.split(".");
  let current: unknown = root;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Extract the terminal key name from a dot-path source expression.
 *
 * For example, `"task.payload.description"` yields `"description"` and
 * `"task.payload.requirements.frontend"` yields `"frontend"`.
 *
 * @param source - Dot-separated source path
 * @returns The last segment of the dot-path
 */
function extractKeyFromSource(source: string): string {
  const segments = source.split(".");
  return segments[segments.length - 1];
}

/**
 * Extract the effective stage identifier from a subtask.
 *
 * Recipe-oriented subtasks carry a `stageId` field; legacy gate-centric
 * subtasks use `stepId` instead. This helper normalizes access so callers
 * do not repeat the fallback logic.
 *
 * @param subtask - Subtask to extract the stage identifier from
 * @returns The stage identifier string
 */
function effectiveStageId(subtask: Subtask): string {
  return subtask.stageId ?? subtask.stepId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve stage inputs from task state and optional orchestrator input patch.
 *
 * Iterates the stage's declared inputs array, resolves each source path
 * against the task state, and collects the resolved values into a flat map
 * keyed by the terminal segment of the source path. The task is wrapped in
 * a `{ task }` context object so paths like `"task.payload.description"`
 * resolve from a root that contains the task.
 *
 * When an `inputPatch` is provided, its values are merged on top using
 * spread semantics -- patch keys win on conflicts with source-resolved keys.
 *
 * This function never throws. Missing source paths resolve to `undefined`.
 *
 * @param stage      - Stage definition containing the inputs array
 * @param task       - Task whose state provides the resolution context
 * @param inputPatch - Optional key-value overrides from the orchestrator decision
 * @returns Flat map of resolved input values
 */
export function resolveInputs(
  stage: StageDefinition,
  task: Task,
  inputPatch?: Record<string, unknown>,
): Record<string, unknown> {
  const context: Record<string, unknown> = { task };
  const resolved: Record<string, unknown> = {};

  for (const input of stage.inputs) {
    const key = extractKeyFromSource(input.source);
    resolved[key] = resolveSourcePath(context, input.source);
  }

  if (inputPatch && Object.keys(inputPatch).length > 0) {
    Object.assign(resolved, inputPatch);
  }

  return resolved;
}

/**
 * Render a three-section prompt in the `# Role / # Task / # Output` format.
 *
 * Produces a markdown prompt body with three distinct sections:
 * - `# Role` -- the stage agent's behavioral instructions
 * - `# Task` -- the objective, resolved inputs, and any additional context
 * - `# Output` -- the expected output contract with labels and formats
 *
 * @param roleContent    - Content of the role file describing agent behavior
 * @param objective      - What the stage agent should accomplish
 * @param resolvedInputs - Resolved input values to include in the task section
 * @param outputs        - Declared stage outputs defining the output contract
 * @returns The fully rendered prompt body as a single string
 */
export function renderPrompt(
  roleContent: string,
  objective: string,
  resolvedInputs: Record<string, unknown>,
  outputs: readonly StageOutput[],
): string {
  const sections: string[] = [];

  // Role section
  sections.push(`# Role\n\n${roleContent}`);

  // Task section with objective and resolved inputs
  let taskSection = `# Task\n\n${objective}`;
  const inputEntries = Object.entries(resolvedInputs);
  if (inputEntries.length > 0) {
    taskSection += "\n\n## Inputs\n";
    for (const [key, value] of inputEntries) {
      taskSection += `\n**${key}**: ${String(value)}`;
    }
  }
  sections.push(taskSection);

  // Output section with the output contract
  let outputSection = "# Output\n\nExpected outputs:\n";
  for (const out of outputs) {
    outputSection += `\n- **${out.label}** (${out.format})`;
  }
  sections.push(outputSection);

  return sections.join("\n\n");
}

/**
 * Invoke the CLI worker backend for a stage-agent execution.
 *
 * Constructs an {@link AgentConfig} from the recipe's orchestrator config
 * (model, backend, effort, timeout), resolves the appropriate backend via
 * the registry, and calls `backend.run()` with the rendered prompt as the
 * system prompt.
 *
 * @param prompt  - The fully rendered prompt body from {@link renderPrompt}
 * @param recipe  - Recipe configuration providing orchestrator settings
 * @param task    - Parent task for execution context
 * @param subtask - Subtask being executed (provides stageId for step context)
 * @returns The StepOutput from the backend execution
 * @throws Error from `resolveAgentBackend` if the backend name is unregistered
 * @throws Error from `backend.run` if the CLI worker execution fails
 */
export async function executeStageAgent(
  prompt: string,
  recipe: RecipeConfig,
  task: Task,
  subtask: Subtask,
): Promise<StepOutput> {
  const orch = recipe.orchestrator;

  const agentConfig: AgentConfig = {
    model: orch.model,
    tools: [],
    timeoutMs: orch.timeout_ms,
    backend: orch.backend,
    effort: orch.effort,
    systemPrompt: prompt,
  };

  const stageId = effectiveStageId(subtask);

  const stepContext: StepContext = {
    taskId: task.id,
    taskPayload: task.payload,
    gateId: recipe.id,
    stepId: stageId,
    workspacePath: task.workspacePath,
    priorOutputs: {},
  };

  const backend = resolveAgentBackend(agentConfig);
  return backend.run(agentConfig, stepContext);
}

/**
 * Normalize CLI worker output into structured artifacts with durable IDs.
 *
 * For each declared stage output, generates a UUID artifact identifier via
 * `crypto.randomUUID()`, writes the artifact content to the task's artifact
 * directory (`<runsDir>/<taskId>/artifacts/<artifactId>.<format>`), appends
 * an `artifact_registered` journal entry, and optionally creates
 * compatibility mirrors at workspace-local paths specified by `mirror_to`.
 *
 * When the stage declares no outputs, returns immediately with an empty
 * `artifactIds` array and no filesystem side effects.
 *
 * @param stepOutput - Raw output from the CLI worker execution
 * @param stage      - Stage definition containing the outputs array
 * @param task       - Parent task (provides taskId and workspacePath)
 * @param subtask    - Subtask being processed (provides stageId)
 * @param runsDir    - Base directory for task run data
 * @returns Structured result with output text and artifact IDs
 */
export async function normalizeOutput(
  stepOutput: StepOutput,
  stage: StageDefinition,
  task: Task,
  subtask: Subtask,
  runsDir: string,
): Promise<StageAgentResult> {
  if (stage.outputs.length === 0) {
    return { output: stepOutput.output, artifactIds: [] };
  }

  const stageId = effectiveStageId(subtask);
  const artifactIds: string[] = [];
  const artifactsDir = path.join(runsDir, task.id, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  for (const output of stage.outputs) {
    const artifactId = randomUUID();
    const filePath = path.join(artifactsDir, `${artifactId}.${output.format}`);

    await writeFile(filePath, stepOutput.output, "utf-8");
    artifactIds.push(artifactId);

    appendJournalEntry(runsDir, task.id, {
      type: "artifact_registered",
      artifactId,
      label: output.label,
      format: output.format,
      stageId,
    });

    if (output.mirror_to && task.workspacePath) {
      for (const mirrorRelPath of output.mirror_to) {
        const mirrorAbsPath = path.join(task.workspacePath, mirrorRelPath);
        await mkdir(path.dirname(mirrorAbsPath), { recursive: true });
        await writeFile(mirrorAbsPath, stepOutput.output, "utf-8");
      }
    }
  }

  return { output: stepOutput.output, artifactIds };
}

/**
 * Top-level handler for `stage_agent_run` subtasks.
 *
 * Chains the four stage-agent operations in sequence: resolves inputs from
 * the task state, reads the role file, renders the prompt, invokes the CLI
 * worker backend, and normalizes the output into stored artifacts. This is
 * the primary entry point called by the worker loop for stage-agent dispatch.
 *
 * @param task    - Parent task containing the payload and workspace path
 * @param subtask - The `stage_agent_run` subtask with stageId and payload
 * @param recipe  - Recipe configuration with stage definitions and orchestrator settings
 * @param runsDir - Base directory for task run data and artifact storage
 * @returns Structured result with output text and artifact IDs
 * @throws Error if the stage identifier is not found in the recipe's stages map
 * @throws Error if the role file at `stage.role` cannot be read from disk
 * @throws Error from `executeStageAgent` if the backend invocation fails
 */
export async function handleStageAgentRun(
  task: Task,
  subtask: Subtask,
  recipe: RecipeConfig,
  runsDir: string,
): Promise<StageAgentResult> {
  const stageId = effectiveStageId(subtask);

  const stage = recipe.stages[stageId];
  if (!stage) {
    throw new Error(
      `Stage "${stageId}" not found in recipe "${recipe.id}"`,
    );
  }

  let roleContent: string;
  try {
    roleContent = await readFile(stage.role, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Failed to read role file for stage "${stageId}": ${stage.role} (${code ?? "unknown error"})`,
    );
  }

  const inputPatch = subtask.payload as Record<string, unknown> | undefined;
  const resolvedInputs = resolveInputs(stage, task, inputPatch);

  const prompt = renderPrompt(
    roleContent,
    stage.objective,
    resolvedInputs,
    stage.outputs,
  );

  const stepOutput = await executeStageAgent(prompt, recipe, task, subtask);

  return normalizeOutput(stepOutput, stage, task, subtask, runsDir);
}
