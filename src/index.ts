/**
 * Application entry point and composition root for the Bees platform.
 *
 * Wires all components into a running pipeline: Slack adapter, gate router,
 * recipe router, script registry, BullMQ task queue, executor, dispatcher,
 * and CLI agent backends. Handles startup sequencing, message routing,
 * worker processing, and graceful shutdown on SIGTERM/SIGINT.
 *
 * @module index
 */

import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { initRouter } from "./gates/router.js";
import { createTaskQueue } from "./queue/task-queue.js";
import { executeTask } from "./executor/task-executor.js";
import type { ProgressCallback, ProgressEvent } from "./executor/task-executor.js";
import { runSubtask } from "./executor/subtask-dispatcher.js";
import { runScript } from "./executor/script-runner.js";
import { runTool } from "./executor/tool-runner.js";
import { registerBackend } from "./runners/registry.js";
import { ClaudeCLIBackend } from "./runners/cli-claude.js";
import { CodexCLIBackend } from "./runners/cli-codex.js";
import { GeminiCLIBackend } from "./runners/cli-gemini.js";
import { loadRecipes } from "./recipes/loader.js";
import { initRecipeRouter, detectCollisions } from "./recipes/router.js";
import type { RecipeRouter } from "./recipes/router.js";
import type { RecipeConfig } from "./recipes/types.js";
import { runTask } from "./runtime/worker.js";
import { loadScriptRegistry } from "./scripts/registry.js";
import type { ScriptManifest } from "./scripts/types.js";

import type { Config } from "./utils/config.js";
import type { GateConfig } from "./gates/types.js";
import type { NormalizedMessage } from "./adapters/types.js";
import type { Task } from "./queue/types.js";
import type { RunnerDeps } from "./executor/subtask-dispatcher.js";
import type { StepOutput } from "./runners/types.js";
import type { Job } from "bullmq";

/** Handle returned by startApp for controlling the running application. */
export interface AppHandle {
  /** Gracefully shut down all components. Idempotent. */
  shutdown(): Promise<void>;
}

/** Options for starting the application with overrides for testing. */
export interface StartAppOptions {
  /** Override the gates directory path. */
  gatesDir?: string;
  /** Override the recipes directory path. */
  recipesDir?: string;
  /** Override the runs directory path for recipe task persistence. */
  runsDir?: string;
  /** Override configuration values loaded from environment. */
  config?: Partial<Config>;
  /** Override path to the script manifest YAML file. */
  manifestPath?: string;
  /** Pre-built script registry, bypasses file loading when provided. */
  scriptRegistry?: Map<string, ScriptManifest>;
}

/** Default gates directory relative to project root. */
const DEFAULT_GATES_DIR = new URL("../gates", import.meta.url).pathname;

/** Default recipes directory relative to project root. */
const DEFAULT_RECIPES_DIR = new URL("../recipes", import.meta.url).pathname;

/** Default runs directory for recipe task persistence. */
const DEFAULT_RUNS_DIR = new URL("../runtime/runs", import.meta.url).pathname;

/** Default script manifest path relative to project root. */
const DEFAULT_MANIFEST_PATH = new URL("../scripts/manifest.yaml", import.meta.url).pathname;

/** Extract a human-readable message from an unknown caught error value. */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deserialize a task from BullMQ job data, converting ISO date strings
 * back to Date objects.
 *
 * BullMQ serializes job data to JSON, which converts Date objects to
 * ISO-8601 strings. This function reverses the conversion for the three
 * date fields present on a Task: createdAt, startedAt, completedAt.
 *
 * @param data - Raw job data record from BullMQ
 * @returns A Task with Date fields restored from ISO strings
 */
function deserializeTask(data: Record<string, unknown>): Task {
  return {
    ...data,
    createdAt: new Date(data.createdAt as string),
    ...(data.startedAt ? { startedAt: new Date(data.startedAt as string) } : {}),
    ...(data.completedAt
      ? { completedAt: new Date(data.completedAt as string) }
      : {}),
  } as Task;
}

/**
 * Send the appropriate completion or failure reply to the source channel
 * after task execution finishes.
 *
 * Centralizes the reply logic that was previously inlined in the processor
 * callback, keeping it focused on orchestration flow.
 *
 * @param adapter - Slack adapter for sending replies
 * @param task    - The executed task (carries status, error, and sourceChannel)
 */
async function sendTaskResultReply(
  adapter: {
    sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void>;
  },
  task: Task,
): Promise<void> {
  if (task.status === "completed") {
    await adapter.sendReply(
      task.sourceChannel,
      `Task ${task.id} completed successfully.`,
    );
  } else if (task.status === "failed") {
    await adapter.sendReply(
      task.sourceChannel,
      `Task ${task.id} failed: ${task.error ?? "Unknown error"}`,
    );
  }
}

/** Adapter capabilities required by the worker processor for thread creation and replies. */
interface WorkerAdapterDeps {
  sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void>;
  createThread: (channelId: string, text: string) => Promise<string>;
}

/**
 * Create a Slack thread for the task and rebind its sourceChannel.
 *
 * On success, overwrites task.sourceChannel so all downstream replies route
 * to the thread. On failure, degrades to flat-channel posting and logs a
 * warning. Shared by both recipe-triggered and gate-triggered worker paths.
 *
 * @param adapter - Slack adapter for thread creation
 * @param task    - The task whose sourceChannel may be updated
 * @param log     - Logger for degraded-posting warnings
 */
async function initTaskThread(
  adapter: WorkerAdapterDeps,
  task: Task,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const threadTs = await adapter.createThread(
      task.sourceChannel.channelId,
      `Task ${task.id} queued for gate "${task.gate}".`,
    );
    task.sourceChannel = { ...task.sourceChannel, threadTs };
  } catch (threadErr: unknown) {
    log.warn("Thread creation failed, degrading to flat-channel posting", {
      taskId: task.id,
      channelId: task.sourceChannel.channelId,
      error: extractErrorMessage(threadErr),
    });
  }
}

/**
 * Handle a worker processor error by logging and notifying the user.
 *
 * Centralizes the error-handling pattern shared by both recipe-triggered and
 * gate-triggered execution paths: log a structured error entry and send a
 * failure reply to the task's source channel.
 *
 * @param adapter - Slack adapter for sending the failure reply
 * @param log     - Logger for structured error reporting
 * @param task    - The failed task (carries id and sourceChannel)
 * @param jobId   - BullMQ job identifier for log correlation
 * @param err     - The caught error
 * @param context - Additional structured log fields (e.g., recipeId)
 */
async function handleWorkerError(
  adapter: WorkerAdapterDeps,
  log: ReturnType<typeof createLogger>,
  task: Task,
  jobId: string | undefined,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const message = extractErrorMessage(err);
  log.error("Worker processor failed", {
    jobId,
    taskId: task.id,
    error: message,
    ...context,
  });
  await adapter.sendReply(
    task.sourceChannel,
    `Task ${task.id} failed: ${message}`,
  );
}

/**
 * Create the BullMQ worker processor callback.
 *
 * The processor deserializes the task from job data, creates a Slack thread,
 * then dispatches based on task type: recipe-triggered tasks (identified by
 * recipeId in job data) route to {@link runTask}, gate-triggered tasks route
 * to {@link executeTask}. Both paths share thread creation via
 * {@link initTaskThread} and error handling via {@link handleWorkerError}.
 *
 * Gate-triggered processing builds per-task runner dependencies with a
 * `stderrSink` closure that routes script stderr to the task's Slack thread,
 * then calls executeTask with progress reporting.
 *
 * @param adapter  - Slack adapter for thread creation, progress, and result replies
 * @param runners  - Shared runner dependencies (copied per-task with stderrSink)
 * @param log      - Logger instance for structured error reporting
 * @param runsDir  - Base directory for recipe task run data persistence
 * @param registry - Script registry for resolving script_run subtasks in recipe-driven tasks
 * @returns Async processor function suitable for TaskQueue.startWorker
 */
function createWorkerProcessor(
  adapter: WorkerAdapterDeps,
  runners: RunnerDeps,
  log: ReturnType<typeof createLogger>,
  runsDir: string,
  registry?: Map<string, ScriptManifest>,
): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    const data = job.data as Record<string, unknown>;
    const task = deserializeTask(data);

    // Create a Slack thread before execution (shared by both paths)
    await initTaskThread(adapter, task, log);

    // Branch on task type: recipe-triggered tasks use runTask, gate-triggered
    // tasks use the existing executeTask path.
    if (data.recipeId) {
      const recipeConfig = data.recipeConfig as RecipeConfig;
      if (!recipeConfig) {
        log.error("Recipe task missing recipeConfig in job data", {
          jobId: job.id,
          taskId: task.id,
          recipeId: data.recipeId,
        });
        await adapter.sendReply(
          task.sourceChannel,
          `Task ${task.id} failed: missing recipe configuration`,
        );
        return;
      }

      try {
        await runTask(task, recipeConfig, runsDir, registry);
        await sendTaskResultReply(adapter, task);
      } catch (err: unknown) {
        await handleWorkerError(adapter, log, task, job.id, err, {
          recipeId: data.recipeId,
        });
      }
      return;
    }

    // Gate-triggered task path (existing behavior)
    const gateConfig = data.gateConfig as GateConfig;

    // Build per-task runners with stderrSink bound to the task's Slack thread.
    // Errors from sendReply are caught and logged to prevent batcher failures
    // from disrupting task execution.
    const taskRunners: RunnerDeps = {
      ...runners,
      stderrSink: async (text: string): Promise<void> => {
        try {
          await adapter.sendReply(task.sourceChannel, text);
        } catch (sinkErr: unknown) {
          log.warn("stderr sink failed to send reply", {
            taskId: task.id,
            error: extractErrorMessage(sinkErr),
          });
        }
      },
    };

    const dispatch = (
      subtask: Parameters<typeof runSubtask>[0],
      step: Parameters<typeof runSubtask>[1],
      context: Parameters<typeof runSubtask>[2],
    ): Promise<StepOutput> => runSubtask(subtask, step, context, taskRunners);

    const onProgress: ProgressCallback = (event: ProgressEvent) => {
      const message = `Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.stepName} (${event.executionType}) -- ${event.status}`;
      void adapter.sendReply(task.sourceChannel, message).catch((err) => {
        log.error("Failed to send progress notification", {
          taskId: task.id,
          error: extractErrorMessage(err),
        });
      });
    };

    try {
      const result = await executeTask(task, gateConfig, dispatch, onProgress);
      await sendTaskResultReply(adapter, result);
    } catch (err: unknown) {
      await handleWorkerError(adapter, log, task, job.id, err);
    }
  };
}

/**
 * Fire-and-forget enqueue of a task with ack/error replies.
 *
 * Shared by both recipe-triggered and gate-triggered message handling paths.
 * Enqueues the enriched task, sends an acknowledgment reply on success, and
 * logs + notifies the user on failure.
 *
 * @param queue      - Task queue for submission
 * @param adapter    - Slack adapter for acknowledgment and error replies
 * @param log        - Logger for structured error reporting
 * @param task       - The task being enqueued (used for id, command context)
 * @param enriched   - The enriched task with embedded config for the worker
 * @param channel    - Source channel for reply routing
 * @param ackMessage - Acknowledgment message sent after successful enqueue
 * @param logContext - Additional structured log fields for error context
 */
function enqueueAndAck(
  queue: { enqueue: (task: Task) => Promise<unknown> },
  adapter: { sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void> },
  log: ReturnType<typeof createLogger>,
  task: Task,
  enriched: Task,
  channel: Task["sourceChannel"],
  ackMessage: string,
  logContext: Record<string, unknown>,
): void {
  void queue
    .enqueue(enriched)
    .then(() => adapter.sendReply(channel, ackMessage))
    .catch((error: unknown) => {
      const errorText = extractErrorMessage(error);
      log.error("Failed to enqueue task", {
        taskId: task.id,
        error: errorText,
        ...logContext,
      });
      return adapter.sendReply(
        channel,
        `Task ${task.id} could not be queued: ${errorText}`,
      );
    });
}

/**
 * Create the Slack onMessage handler that routes commands to the queue.
 *
 * Checks the recipe router first for command matching. When a recipe matches,
 * creates a recipe-driven task with recipeConfig embedded in job data.
 * Falls through to the gate router when no recipe claims the command.
 * Unmatched commands are logged and ignored.
 *
 * @param recipeRouter - Recipe router checked first for command matching
 * @param gateRouter   - Gate router as fallback for non-recipe commands
 * @param adapter      - Slack adapter for sending acknowledgment replies
 * @param queue        - Task queue for enqueuing matched tasks
 * @param log          - Logger instance for warning on unmatched commands
 * @returns Synchronous message handler for adapter.onMessage registration
 */
function createMessageHandler(
  recipeRouter: RecipeRouter,
  gateRouter: Awaited<ReturnType<typeof initRouter>>,
  adapter: { sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void> },
  queue: { enqueue: (task: Task) => Promise<unknown> },
  log: ReturnType<typeof createLogger>,
): (message: NormalizedMessage) => void {
  return (message: NormalizedMessage): void => {
    // Check recipe router first -- recipes take precedence over gates
    const recipeConfig = recipeRouter.match(message.command);
    if (recipeConfig) {
      const task = recipeRouter.createTask(message);
      if (!task) {
        log.warn("Recipe router matched but createTask returned null", {
          command: message.command,
        });
        return;
      }

      const enrichedTask = Object.assign({}, task, { recipeConfig }) as Task;
      enqueueAndAck(
        queue, adapter, log, task, enrichedTask, message.channel,
        `Task ${task.id} queued for recipe "${task.recipeId}".`,
        { recipeId: task.recipeId, command: message.command },
      );
      return;
    }

    // Fall through to gate router
    const task = gateRouter.createTask(message);
    if (!task) {
      log.warn("No gate matched command", { command: message.command });
      return;
    }

    const gateConfig = gateRouter.match(message.command);
    const enrichedTask = Object.assign({}, task, { gateConfig }) as Task;
    enqueueAndAck(
      queue, adapter, log, task, enrichedTask, message.channel,
      `Task ${task.id} queued for gate "${task.gate}".`,
      { command: message.command },
    );
  };
}

/**
 * Boot the application when run directly (not imported as a module).
 * Calls startApp() and keeps the process alive via the Slack Socket Mode
 * connection and BullMQ worker event loop.
 */
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith("/dist/index.js");

if (isMainModule) {
  startApp().catch((err: unknown) => {
    console.error("Fatal: failed to start application", err);
    process.exit(1);
  });
}

/**
 * Boot the application: load config, initialize all components, wire the
 * pipeline, and connect to Slack.
 *
 * Serves as the composition root: creates all components, wires their
 * dependencies, and orchestrates the startup sequence. No business logic
 * lives here -- only component creation and wiring.
 *
 * Startup sequence:
 *   config -> gate router -> recipe router -> script registry ->
 *   task queue -> adapter -> worker -> message handler -> connect
 *
 * @param options - Optional overrides for directories, config, manifest path,
 *   and pre-built script registry (see {@link StartAppOptions})
 * @returns An AppHandle with a shutdown method for graceful teardown
 */
export async function startApp(options?: StartAppOptions): Promise<AppHandle> {
  const config = { ...loadConfig(), ...options?.config };
  const log = createLogger(config.logLevel);
  const gatesDir = options?.gatesDir ?? DEFAULT_GATES_DIR;
  const recipesDir = options?.recipesDir ?? DEFAULT_RECIPES_DIR;
  const runsDir = options?.runsDir ?? DEFAULT_RUNS_DIR;

  // Register real CLI backends (replacing default stubs)
  registerBackend("cli-claude", new ClaudeCLIBackend());
  registerBackend("cli-codex", new CodexCLIBackend());
  registerBackend("cli-gemini", new GeminiCLIBackend());
  log.info("CLI agent backends registered", { backends: ["cli-claude", "cli-codex", "cli-gemini"] });

  // Initialize the gate router (auto-discover YAML files)
  const router = await initRouter(gatesDir);

  // Load recipes and initialize the recipe router
  const recipes = await loadRecipes(recipesDir);
  const recipeRouter = initRecipeRouter(recipes);
  log.info(`Recipe router initialized with ${recipes.size} recipe(s)`, {
    activeRecipes: recipes.size,
    recipesDir,
  });

  // Detect command collisions between recipes and gates at startup
  detectCollisions(recipeRouter, router, log);

  // Load or inject the script registry for script_run dispatch
  const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH;
  let registry: Map<string, ScriptManifest>;
  if (options?.scriptRegistry) {
    registry = options.scriptRegistry;
  } else {
    const basePath = new URL("..", import.meta.url).pathname;
    registry = await loadScriptRegistry(manifestPath, basePath);
  }
  log.info(`Script registry loaded with ${registry.size} script(s)`, {
    scriptCount: registry.size,
    source: options?.scriptRegistry ? "override" : "manifest",
    manifestPath,
  });

  // Create the task queue with Redis connection
  const queue = createTaskQueue({ redisUrl: config.redisUrl });

  // Create the Slack adapter
  const adapter = createSlackAdapter({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
  });

  // Build runner dependencies for the subtask dispatcher
  const runners: RunnerDeps = { runScript, runTool };

  // Wire the worker processor and message handler (dual-router pipeline)
  const processor = createWorkerProcessor(adapter, runners, log, runsDir, registry);
  queue.startWorker(processor);

  const messageHandler = createMessageHandler(recipeRouter, router, adapter, queue, log);
  adapter.onMessage(messageHandler);

  // Connect the Slack adapter (starts Socket Mode).
  // Clean up queue/worker resources if connection fails.
  try {
    await adapter.connect();
  } catch (error) {
    await Promise.allSettled([queue.close(), adapter.disconnect()]);
    throw error;
  }

  log.info("Application started successfully", { gatesDir });

  // Shared shutdown promise so concurrent callers await the same operation
  let shutdownPromise: Promise<void> | null = null;

  /** Coordinated shutdown of all components. Removes its own signal listeners. */
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      // Remove signal listeners to prevent listener accumulation across restarts
      process.off("SIGTERM", signalHandler);
      process.off("SIGINT", signalHandler);

      log.info("Shutting down application");

      const [adapterResult, queueResult] = await Promise.allSettled([
        adapter.disconnect(),
        queue.close(),
      ]);
      if (adapterResult.status === "rejected") {
        log.error("Adapter disconnect failed", { error: extractErrorMessage(adapterResult.reason) });
      }
      if (queueResult.status === "rejected") {
        log.error("Queue close failed", { error: extractErrorMessage(queueResult.reason) });
      }

      log.info("Application shutdown complete");
    })();

    return shutdownPromise;
  };

  /** Bound signal handler enabling cleanup via process.off on shutdown. */
  const signalHandler = (): void => {
    void shutdown();
  };

  // Register process signal handlers for graceful shutdown
  process.on("SIGTERM", signalHandler);
  process.on("SIGINT", signalHandler);

  return { shutdown };
}
