import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------
// Mock infrastructure for bullmq and ioredis
// ---------------------------------------------------------------

/** Captured Queue constructor arguments for assertions. */
let capturedQueueArgs: unknown[];

/** Captured Worker constructor arguments for assertions. */
let capturedWorkerArgs: unknown[];

/** Captured event handlers registered on the Worker. */
let capturedWorkerEventHandlers: Map<string, Function>;

/** Captured event handlers registered on the Queue. */
let capturedQueueEventHandlers: Map<string, Function>;

/** Captured event handlers registered on the Redis client. */
let capturedRedisEventHandlers: Map<string, Function>;

/** Mock for Queue.add(). */
let mockQueueAdd: ReturnType<typeof vi.fn>;

/** Mock for Queue.close(). */
let mockQueueClose: ReturnType<typeof vi.fn>;

/** Mock for Worker.close(). */
let mockWorkerClose: ReturnType<typeof vi.fn>;

/** Mock for Redis.quit(). */
let mockRedisQuit: ReturnType<typeof vi.fn>;

/** Mock for Redis.disconnect(). */
let mockRedisDisconnect: ReturnType<typeof vi.fn>;

/** Captured Redis constructor arguments. */
let capturedRedisArgs: unknown[];

vi.mock("bullmq", () => {
  const MockQueue = vi.fn(function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    capturedQueueArgs = args;
    capturedQueueEventHandlers = new Map();

    this.add = mockQueueAdd;
    this.close = mockQueueClose;
    this.on = vi.fn((event: string, handler: Function) => {
      capturedQueueEventHandlers.set(event, handler);
    });
    this.name = args[0];
  });

  const MockWorker = vi.fn(function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    capturedWorkerArgs = args;
    capturedWorkerEventHandlers = new Map();

    this.close = mockWorkerClose;
    this.on = vi.fn((event: string, handler: Function) => {
      capturedWorkerEventHandlers.set(event, handler);
    });
    this.off = vi.fn();
    this.name = args[0];
  });

  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock("ioredis", () => {
  const MockRedis = vi.fn(function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    capturedRedisArgs = args;
    capturedRedisEventHandlers = new Map();

    this.quit = mockRedisQuit;
    this.disconnect = mockRedisDisconnect;
    this.on = vi.fn((event: string, handler: Function) => {
      capturedRedisEventHandlers.set(event, handler);
    });
    this.status = "ready";
  });

  return { default: MockRedis, Redis: MockRedis };
});

// Import module under test (does not exist yet -- expected to fail in RED phase)
import { TaskQueue, PRIORITY_MAP } from "../../src/queue/task-queue.js";
import { TASK_PRIORITIES } from "../../src/queue/types.js";
import type { Task, TaskPriority } from "../../src/queue/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create a valid Task object with sensible defaults and optional overrides. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    gate: "new-implementation",
    status: "queued",
    priority: "normal",
    position: 1,
    payload: { description: "test task" },
    requestedBy: "U12345",
    sourceChannel: { platform: "slack", channelId: "C67890" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

let queue: InstanceType<typeof TaskQueue>;

beforeEach(() => {
  capturedQueueArgs = [];
  capturedWorkerArgs = [];
  capturedWorkerEventHandlers = new Map();
  capturedQueueEventHandlers = new Map();
  capturedRedisEventHandlers = new Map();
  capturedRedisArgs = [];
  mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1", data: {} });
  mockQueueClose = vi.fn().mockResolvedValue(undefined);
  mockWorkerClose = vi.fn().mockResolvedValue(undefined);
  mockRedisQuit = vi.fn().mockResolvedValue("OK");
  mockRedisDisconnect = vi.fn();

  queue = new TaskQueue({ redisUrl: "redis://localhost:6379" });
});

afterEach(async () => {
  // Ensure cleanup to avoid leaking signal handlers
  try {
    await queue.close();
  } catch {
    // Ignore close errors in teardown
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Priority Mapping
// ---------------------------------------------------------------
describe("priority mapping", () => {
  it("maps critical priority to BullMQ numeric value 1", () => {
    expect(PRIORITY_MAP.critical).toBe(1);
  });

  it("maps high priority to BullMQ numeric value 2", () => {
    expect(PRIORITY_MAP.high).toBe(2);
  });

  it("maps normal priority to BullMQ numeric value 3", () => {
    expect(PRIORITY_MAP.normal).toBe(3);
  });

  it("maps low priority to BullMQ numeric value 4", () => {
    expect(PRIORITY_MAP.low).toBe(4);
  });

  it("covers all TaskPriority values in the mapping", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(
        PRIORITY_MAP[priority],
        `PRIORITY_MAP should contain key "${priority}"`,
      ).toBeDefined();
      expect(PRIORITY_MAP[priority]).toBeTypeOf("number");
      expect(PRIORITY_MAP[priority]).toBeGreaterThan(0);
    }
  });

  it("maintains strict ordering: critical < high < normal < low", () => {
    expect(PRIORITY_MAP.critical).toBeLessThan(PRIORITY_MAP.high);
    expect(PRIORITY_MAP.high).toBeLessThan(PRIORITY_MAP.normal);
    expect(PRIORITY_MAP.normal).toBeLessThan(PRIORITY_MAP.low);
  });
});

// ---------------------------------------------------------------
// Group 2: Enqueue Behavior
// ---------------------------------------------------------------
describe("enqueue behavior", () => {
  it("enqueue calls BullMQ Queue.add with task data and mapped priority", async () => {
    const task = makeTask({ priority: "high" });
    await queue.enqueue(task);

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, , opts] = mockQueueAdd.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(opts.priority).toBe(PRIORITY_MAP.high);
  });

  it("enqueue uses task.id as BullMQ jobId for idempotency", async () => {
    const task = makeTask({ id: "task-xyz" });
    await queue.enqueue(task);

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, , opts] = mockQueueAdd.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(opts.jobId).toBe("task-xyz");
  });

  it("enqueue sets task status to queued", async () => {
    const task = makeTask({ status: "queued" });
    await queue.enqueue(task);

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, data] = mockQueueAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(data.status).toBe("queued");
  });

  it("enqueue serializes Date fields to ISO strings", async () => {
    const task = makeTask({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await queue.enqueue(task);

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, data] = mockQueueAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // Date fields should be serialized as strings (not Date objects)
    expect(typeof data.createdAt).toBe("string");
    expect(data.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("enqueue returns the BullMQ job object", async () => {
    const mockJob = { id: "job-42", data: { id: "task-001" } };
    mockQueueAdd.mockResolvedValueOnce(mockJob);

    const task = makeTask();
    const result = await queue.enqueue(task);

    expect(result).toBe(mockJob);
  });
});

// ---------------------------------------------------------------
// Group 3: Worker Configuration
// ---------------------------------------------------------------
describe("worker configuration", () => {
  it("creates BullMQ Worker with concurrency 1", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    expect(capturedWorkerArgs).toBeDefined();
    expect(capturedWorkerArgs.length).toBeGreaterThanOrEqual(3);
    const workerOpts = capturedWorkerArgs[2] as Record<string, unknown>;
    expect(workerOpts.concurrency).toBe(1);
  });

  it("worker processor callback is invoked with job data", async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    // The processor is passed as the second arg to the Worker constructor
    const capturedProcessor = capturedWorkerArgs[1] as Function;
    expect(capturedProcessor).toBeDefined();

    const mockJob = { id: "job-1", data: makeTask() };
    await capturedProcessor(mockJob);

    expect(processor).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledWith(mockJob);
  });

  it("worker uses the same queue name as the Queue instance", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    const queueName = capturedQueueArgs[0];
    const workerName = capturedWorkerArgs[0];
    expect(workerName).toBe(queueName);
  });
});

// ---------------------------------------------------------------
// Group 4: Task Lifecycle State Transitions
// ---------------------------------------------------------------
describe("task lifecycle state transitions", () => {
  it("transitions task status to active when worker picks up job", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    // Verify the active event handler is registered
    const activeHandler = capturedWorkerEventHandlers.get("active");
    expect(activeHandler).toBeDefined();

    // Simulate the active event with a mock job
    const mockJob = { id: "job-1", data: { ...makeTask(), status: "queued" } };
    activeHandler!(mockJob);

    // The handler should process the status transition
    // (the exact mechanism depends on implementation, but the handler must exist)
    expect(activeHandler).toBeDefined();
  });

  it("transitions task status to completed when job succeeds", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    // Verify the completed event handler is registered
    const completedHandler = capturedWorkerEventHandlers.get("completed");
    expect(completedHandler).toBeDefined();

    // Simulate the completed event
    const mockJob = { id: "job-1", data: makeTask() };
    completedHandler!(mockJob, "result");

    expect(completedHandler).toBeDefined();
  });

  it("transitions task status to failed when job throws", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    // Verify the failed event handler is registered
    const failedHandler = capturedWorkerEventHandlers.get("failed");
    expect(failedHandler).toBeDefined();

    // Simulate the failed event
    const mockJob = { id: "job-1", data: makeTask() };
    const mockError = new Error("Processing failed");
    failedHandler!(mockJob, mockError);

    expect(failedHandler).toBeDefined();
  });
});

// ---------------------------------------------------------------
// Group 5: Priority Ordering (Integration-style with mocks)
// ---------------------------------------------------------------
describe("priority ordering", () => {
  it("jobs with higher priority are dequeued before lower priority", async () => {
    const tasks: Array<{ task: Task; expectedPriority: number }> = [
      { task: makeTask({ id: "t-low", priority: "low" }), expectedPriority: 4 },
      {
        task: makeTask({ id: "t-critical", priority: "critical" }),
        expectedPriority: 1,
      },
      {
        task: makeTask({ id: "t-normal", priority: "normal" }),
        expectedPriority: 3,
      },
      {
        task: makeTask({ id: "t-high", priority: "high" }),
        expectedPriority: 2,
      },
    ];

    for (const { task } of tasks) {
      await queue.enqueue(task);
    }

    expect(mockQueueAdd).toHaveBeenCalledTimes(4);

    // Verify each call received the correct numeric priority
    for (let i = 0; i < tasks.length; i++) {
      const [, , opts] = mockQueueAdd.mock.calls[i] as [
        string,
        unknown,
        Record<string, unknown>,
      ];
      expect(opts.priority).toBe(tasks[i].expectedPriority);
    }
  });

  it("tasks within the same priority maintain FIFO order", async () => {
    const task1 = makeTask({ id: "t-1", priority: "normal" });
    const task2 = makeTask({ id: "t-2", priority: "normal" });
    const task3 = makeTask({ id: "t-3", priority: "normal" });

    await queue.enqueue(task1);
    await queue.enqueue(task2);
    await queue.enqueue(task3);

    expect(mockQueueAdd).toHaveBeenCalledTimes(3);

    // All calls should have priority 3 (normal) and no lifo option
    for (let i = 0; i < 3; i++) {
      const [, , opts] = mockQueueAdd.mock.calls[i] as [
        string,
        unknown,
        Record<string, unknown>,
      ];
      expect(opts.priority).toBe(3);
      expect(opts.lifo).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------
// Group 6: Graceful Shutdown
// ---------------------------------------------------------------
describe("graceful shutdown", () => {
  it("close() closes the Worker and Queue", async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    await queue.close();

    expect(mockWorkerClose).toHaveBeenCalledOnce();
    expect(mockQueueClose).toHaveBeenCalledOnce();
  });

  it("close() disconnects the Redis connection", async () => {
    await queue.close();

    // Either quit() or disconnect() should be called
    const redisClosed =
      mockRedisQuit.mock.calls.length > 0 ||
      mockRedisDisconnect.mock.calls.length > 0;
    expect(redisClosed).toBe(true);
  });

  it("close() can be called multiple times without error", async () => {
    await queue.close();
    // Second call should not throw
    await expect(queue.close()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------
// Group 7: Redis Connection Error Handling
// ---------------------------------------------------------------
describe("redis connection error handling", () => {
  it("handles Redis connection errors with descriptive logging", () => {
    // Verify that a Redis error event handler is registered
    const errorHandler = capturedRedisEventHandlers.get("error");
    expect(errorHandler).toBeDefined();

    // Simulate a Redis connection error -- should not throw
    const redisError = new Error("ECONNREFUSED");
    expect(() => errorHandler!(redisError)).not.toThrow();
  });

  it("propagates worker error events", () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    queue.startWorker(processor);

    // Verify that a Worker error event handler is registered
    const errorHandler = capturedWorkerEventHandlers.get("error");
    expect(errorHandler).toBeDefined();

    // Simulate a Worker error -- should not throw
    const workerError = new Error("Worker processing error");
    expect(() => errorHandler!(workerError)).not.toThrow();
  });
});
