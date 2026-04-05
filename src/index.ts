/**
 * Application entry point and composition root for the Bees platform.
 *
 * Wires all components into a running pipeline: Slack adapter, gate router,
 * BullMQ task queue, executor, dispatcher, and CLI agent backends. Handles
 * startup sequencing, message routing, worker processing, and graceful
 * shutdown on SIGTERM/SIGINT.
 *
 * @module index
 */

import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { initRouter } from "./gates/router.js";
import { createTaskQueue } from "./queue/task-queue.js";
import { executeTask } from "./executor/task-executor.js";
import { runSubtask } from "./executor/subtask-dispatcher.js";
import { runScript } from "./executor/script-runner.js";
import { runTool } from "./executor/tool-runner.js";

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
  /** Override configuration values loaded from environment. */
  config?: Partial<Config>;
}

/** Default gates directory relative to project root. */
const DEFAULT_GATES_DIR = new URL("../gates", import.meta.url).pathname;

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
  adapter: { sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void> },
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

/**
 * Create the BullMQ worker processor callback.
 *
 * The processor deserializes the task from job data, extracts the embedded
 * GateConfig, builds the dispatch function binding RunnerDeps to runSubtask,
 * calls executeTask, and sends the result reply via the adapter.
 *
 * @param adapter - Slack adapter for sending completion/failure replies
 * @param runners - Injected runner dependencies for subtask dispatch
 * @param log     - Logger instance for structured error reporting
 * @returns Async processor function suitable for TaskQueue.startWorker
 */
function createWorkerProcessor(
  adapter: { sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void> },
  runners: RunnerDeps,
  log: ReturnType<typeof createLogger>,
): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    const data = job.data as Record<string, unknown>;
    const task = deserializeTask(data);
    const gateConfig = data.gateConfig as GateConfig;

    const dispatch = (
      subtask: Parameters<typeof runSubtask>[0],
      step: Parameters<typeof runSubtask>[1],
      context: Parameters<typeof runSubtask>[2],
    ): Promise<StepOutput> => runSubtask(subtask, step, context, runners);

    try {
      const result = await executeTask(task, gateConfig, dispatch);
      await sendTaskResultReply(adapter, result);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      log.error("Worker processor failed", {
        jobId: job.id,
        taskId: task.id,
        error: message,
      });
      await adapter.sendReply(
        task.sourceChannel,
        `Task ${task.id} failed: ${message}`,
      );
    }
  };
}

/**
 * Create the Slack onMessage handler that routes commands to the queue.
 *
 * Matches incoming messages against the gate router. When a gate matches,
 * sends an acknowledgment reply and enqueues the task with the GateConfig
 * embedded in the job data. Unmatched commands are logged and ignored.
 *
 * @param router  - Gate router for command matching and task creation
 * @param adapter - Slack adapter for sending acknowledgment replies
 * @param queue   - Task queue for enqueuing matched tasks
 * @param log     - Logger instance for warning on unmatched commands
 * @returns Synchronous message handler for adapter.onMessage registration
 */
function createMessageHandler(
  router: Awaited<ReturnType<typeof initRouter>>,
  adapter: { sendReply: (channel: Task["sourceChannel"], text: string) => Promise<void> },
  queue: { enqueue: (task: Task) => Promise<unknown> },
  log: ReturnType<typeof createLogger>,
): (message: NormalizedMessage) => void {
  return (message: NormalizedMessage): void => {
    const task = router.createTask(message);
    if (!task) {
      log.warn("No gate matched command", { command: message.command });
      return;
    }

    const gateConfig = router.match(message.command);

    void adapter.sendReply(
      message.channel,
      `Task ${task.id} queued for gate "${task.gate}".`,
    );

    const enrichedTask = Object.assign({}, task, { gateConfig }) as Task;
    void queue.enqueue(enrichedTask);
  };
}

/**
 * Boot the application: load config, initialize all components, wire the
 * pipeline, and connect to Slack.
 *
 * Serves as the composition root: creates all components, wires their
 * dependencies, and orchestrates the startup sequence. No business logic
 * lives here -- only component creation and wiring.
 *
 * Startup sequence: config -> router -> queue -> adapter -> worker -> message handler -> connect
 *
 * @param options - Optional overrides for gates directory and config values
 * @returns An AppHandle with a shutdown method for graceful teardown
 */
export async function startApp(options?: StartAppOptions): Promise<AppHandle> {
  const config = { ...loadConfig(), ...options?.config };
  const log = createLogger(config.logLevel);
  const gatesDir = options?.gatesDir ?? DEFAULT_GATES_DIR;

  // Initialize the gate router (auto-discover YAML files)
  const router = await initRouter(gatesDir);

  // Create the task queue with Redis connection
  const queue = createTaskQueue({ redisUrl: config.redisUrl });

  // Create the Slack adapter
  const adapter = createSlackAdapter({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
  });

  // Build runner dependencies for the subtask dispatcher
  const runners: RunnerDeps = { runScript, runTool };

  // Wire the worker processor and message handler
  const processor = createWorkerProcessor(adapter, runners, log);
  queue.startWorker(processor);

  const messageHandler = createMessageHandler(router, adapter, queue, log);
  adapter.onMessage(messageHandler);

  // Connect the Slack adapter (starts Socket Mode)
  await adapter.connect();

  log.info("Application started successfully", { gatesDir });

  // Idempotency guard for shutdown
  let shuttingDown = false;

  /** Coordinated shutdown of all components. Removes its own signal listeners. */
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Remove signal listeners to prevent listener accumulation across restarts
    process.off("SIGTERM", signalHandler);
    process.off("SIGINT", signalHandler);

    log.info("Shutting down application");

    await adapter.disconnect();
    await queue.close();

    log.info("Application shutdown complete");
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
