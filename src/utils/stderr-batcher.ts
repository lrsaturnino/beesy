/**
 * Stderr batcher utility -- accumulates stderr lines and flushes them
 * to a generic async sink at configurable intervals.
 *
 * Provides throttle/batch protection when forwarding high-frequency
 * stderr output to rate-limited destinations. The batcher is a pure
 * utility with no knowledge of Slack or any specific adapter -- it
 * receives a generic async sink callback.
 *
 * @module utils/stderr-batcher
 */

/**
 * Async callback that receives the joined stderr text on each flush.
 * The sink is called with all accumulated lines joined by newline
 * characters. It is never called with an empty string.
 */
export type StderrBatcherSink = (text: string) => Promise<void>;

/** Public interface returned by the stderr batcher factory. */
export interface StderrBatcher {
  /** Append lines to the internal buffer. Empty arrays are ignored. */
  push(lines: string[]): void;
  /**
   * Manually drain the buffer and send accumulated content to the sink.
   * Does nothing when the buffer is empty.
   */
  flush(): Promise<void>;
  /**
   * Stop the automatic flush interval and drain any remaining buffer.
   * After disposal, no further automatic flushes will occur.
   */
  dispose(): Promise<void>;
}

/** Default flush interval in milliseconds. */
const DEFAULT_INTERVAL_MS = 2000;

/**
 * Create a stderr batcher that accumulates lines and flushes them
 * to the provided sink at a regular interval.
 *
 * The internal buffer is drained atomically before awaiting the sink,
 * which prevents race conditions between concurrent auto-flush and
 * manual flush operations.
 *
 * @param sink - Async callback that receives the joined buffer content
 * @param intervalMs - Flush interval in milliseconds (default 2000)
 * @returns Batcher object with push, flush, and dispose methods
 */
export function createStderrBatcher(
  sink: StderrBatcherSink,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): StderrBatcher {
  let buffer: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function drainBuffer(): Promise<void> {
    const lines = buffer.splice(0);
    if (lines.length === 0) {
      return;
    }
    await sink(lines.join("\n"));
  }

  timer = setInterval(() => {
    void drainBuffer();
  }, intervalMs);

  return {
    push(lines: string[]): void {
      if (lines.length === 0) {
        return;
      }
      buffer.push(...lines);
    },

    flush(): Promise<void> {
      return drainBuffer();
    },

    async dispose(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await drainBuffer();
    },
  };
}
