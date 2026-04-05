/**
 * BullMQ task queue wrapper with priority-based sequential processing.
 *
 * Wraps BullMQ Queue and Worker with an ioredis connection, mapping domain
 * priority levels (critical, high, normal, low) to BullMQ numeric priorities.
 * Enforces FIFO ordering within the same priority and processes tasks
 * sequentially with concurrency = 1.
 *
 * The queue does not import any executor logic directly. Instead, the
 * processor callback is injected via {@link TaskQueue.startWorker} at
 * application startup, keeping the queue decoupled from execution concerns.
 *
 * @module queue/task-queue
 */

import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import type { Task, TaskPriority } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Default BullMQ queue name for the Bees platform. */
const DEFAULT_QUEUE_NAME = "bees-tasks";

/**
 * Maps domain priority levels to BullMQ numeric priorities.
 *
 * BullMQ uses lower numbers for higher priority. Value 0 is intentionally
 * avoided because BullMQ treats it as "no priority set" (default behavior).
 * FIFO ordering within the same numeric priority is guaranteed by BullMQ
 * when the `lifo` option is not set.
 */
export const PRIORITY_MAP: Readonly<Record<TaskPriority, number>> = {
  critical: 1,
  high: 2,
  normal: 3,
  low: 4,
} as const;

/**
 * Configuration options for creating a {@link TaskQueue} instance.
 *
 * At minimum, a Redis URL is required. The queue name defaults to
 * `"bees-tasks"` when not specified.
 */
export interface TaskQueueOptions {
  /** Redis connection URL (e.g., "redis://localhost:6379"). */
  readonly redisUrl: string;
  /** BullMQ queue name. Defaults to "bees-tasks". */
  readonly queueName?: string;
}

/** Extract a human-readable message from an unknown caught error value. */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Convert Date fields in a Task to ISO strings for JSON-safe BullMQ storage.
 *
 * BullMQ serializes job data to JSON, which converts Date objects to strings
 * implicitly. This function makes the conversion explicit and predictable so
 * downstream consumers know to expect ISO-8601 date strings.
 */
function serializeTask(task: Task): Record<string, unknown> {
  return {
    ...task,
    createdAt:
      task.createdAt instanceof Date
        ? task.createdAt.toISOString()
        : task.createdAt,
    startedAt:
      task.startedAt instanceof Date
        ? task.startedAt.toISOString()
        : task.startedAt,
    completedAt:
      task.completedAt instanceof Date
        ? task.completedAt.toISOString()
        : task.completedAt,
  };
}

/**
 * BullMQ task queue wrapper providing priority-ordered sequential processing.
 *
 * Creates a BullMQ Queue backed by ioredis for enqueuing tasks with mapped
 * priorities, and a Worker (via {@link startWorker}) for processing tasks one
 * at a time. Handles task lifecycle event transitions and graceful shutdown.
 *
 * Lifecycle:
 * 1. Construct with {@link TaskQueueOptions} (creates Queue + Redis)
 * 2. Call {@link startWorker} with an injected processor callback
 * 3. Call {@link enqueue} to add tasks
 * 4. Call {@link close} for graceful teardown (also triggered by SIGTERM/SIGINT)
 */
export class TaskQueue {
  /** BullMQ Queue instance for adding jobs. */
  private readonly queue: Queue;

  /** Shared ioredis connection used by Queue and Worker. */
  private readonly connection: Redis;

  /** BullMQ queue name shared between Queue and Worker. */
  private readonly queueName: string;

  /** BullMQ Worker instance, created lazily via startWorker(). */
  private worker: Worker | null = null;

  /** Guards against duplicate close() calls. */
  private closed = false;

  /** Bound reference to the shutdown handler for signal cleanup. */
  private readonly shutdownHandler: () => void;

  constructor(options: TaskQueueOptions) {
    this.queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    this.connection = new Redis(options.redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.connection.on("error", (err: unknown) => {
      const message = extractErrorMessage(err);
      logger.error("Redis connection error", {
        error: message,
        queue: this.queueName,
      });
    });

    this.queue = new Queue(this.queueName, {
      connection: this.connection,
    });

    this.shutdownHandler = () => {
      void this.close();
    };
    process.on("SIGTERM", this.shutdownHandler);
    process.on("SIGINT", this.shutdownHandler);
  }

  /**
   * Add a task to the queue with its priority mapped to a BullMQ numeric value.
   *
   * Date fields are serialized to ISO-8601 strings for JSON compatibility.
   * The task ID is used as the BullMQ job ID to ensure idempotent enqueue
   * (adding the same task twice is a no-op if the first job still exists).
   *
   * @param task - The Task object to enqueue
   * @returns The BullMQ Job object created by Queue.add
   */
  async enqueue(task: Task): Promise<Job> {
    const serializedData = serializeTask(task);
    const numericPriority = PRIORITY_MAP[task.priority];

    const job = await this.queue.add(this.queueName, serializedData, {
      priority: numericPriority,
      jobId: task.id,
    });

    logger.info("Task enqueued", {
      taskId: task.id,
      priority: task.priority,
      numericPriority,
    });

    return job;
  }

  /**
   * Create and start a BullMQ Worker with an injected processor callback.
   *
   * The worker processes tasks sequentially (concurrency = 1) and registers
   * lifecycle event handlers for active, completed, failed, and error events.
   * Call this once at application startup after the executor is ready.
   *
   * @param processor - Async callback invoked for each dequeued job
   */
  startWorker(processor: (job: Job) => Promise<void>): void {
    const worker = new Worker(this.queueName, processor, {
      connection: this.connection,
      concurrency: 1,
    });

    worker.on("active", (job: Job) => {
      logger.info("Task active", { jobId: job.id });
    });

    worker.on("completed", (job: Job) => {
      logger.info("Task completed", { jobId: job.id });
    });

    worker.on("failed", (job: Job | undefined, err: Error) => {
      logger.error("Task failed", {
        jobId: job?.id,
        error: err.message,
      });
    });

    worker.on("error", (err: Error) => {
      logger.error("Worker error", { error: err.message });
    });

    this.worker = worker;
  }

  /**
   * Graceful shutdown: close Worker, Queue, and Redis connection in order.
   *
   * The Worker is closed first so it stops picking up new jobs and waits for
   * any active job to finish. Then the Queue is closed to flush pending
   * operations. Finally, the Redis connection is terminated.
   *
   * Idempotent -- safe to call multiple times without error.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    process.off("SIGTERM", this.shutdownHandler);
    process.off("SIGINT", this.shutdownHandler);

    if (this.worker) {
      await this.worker.close();
    }

    await this.queue.close();
    await this.connection.quit();

    logger.info("TaskQueue shut down", { queue: this.queueName });
  }
}

/**
 * Factory function to create a TaskQueue for dependency injection.
 *
 * @param options - Queue configuration with Redis URL and optional queue name
 * @returns A new TaskQueue instance
 */
export function createTaskQueue(options: TaskQueueOptions): TaskQueue {
  return new TaskQueue(options);
}
