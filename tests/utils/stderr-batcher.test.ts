import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------

import { createStderrBatcher } from "../../src/utils/stderr-batcher.js";

// ---------------------------------------------------------------
// Group 1: Factory and Configuration
// ---------------------------------------------------------------

describe("factory and configuration", () => {
  it("returns object with push, flush, and dispose methods", () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    expect(typeof batcher.push).toBe("function");
    expect(typeof batcher.flush).toBe("function");
    expect(typeof batcher.dispose).toBe("function");

    batcher.dispose();
  });

  it("uses default interval of 2000ms when not specified", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn().mockResolvedValue(undefined);
      const batcher = createStderrBatcher(sink);

      batcher.push(["default interval test"]);

      await vi.advanceTimersByTimeAsync(1999);
      expect(sink).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sink).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledWith("default interval test");

      await batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses custom interval when specified", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn().mockResolvedValue(undefined);
      const batcher = createStderrBatcher(sink, 500);

      batcher.push(["custom interval test"]);

      await vi.advanceTimersByTimeAsync(499);
      expect(sink).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sink).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledWith("custom interval test");

      await batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------
// Group 2: push Behavior
// ---------------------------------------------------------------

describe("push behavior", () => {
  it("accumulates lines in buffer", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["line1", "line2"]);
    await batcher.flush();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("line1\nline2");

    await batcher.dispose();
  });

  it("accumulates across multiple push calls", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["a"]);
    batcher.push(["b", "c"]);
    await batcher.flush();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("a\nb\nc");

    await batcher.dispose();
  });

  it("does not add to buffer when pushing empty array", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push([]);
    await batcher.flush();

    expect(sink).not.toHaveBeenCalled();

    await batcher.dispose();
  });
});

// ---------------------------------------------------------------
// Group 3: Automatic Flush (Timer-Based)
// ---------------------------------------------------------------

describe("automatic flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls sink with accumulated lines after interval elapses", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink, 1000);

    batcher.push(["stderr line 1", "stderr line 2"]);

    await vi.advanceTimersByTimeAsync(1000);

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("stderr line 1\nstderr line 2");

    await batcher.dispose();
  });

  it("clears buffer after flushing", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink, 1000);

    batcher.push(["x"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sink).toHaveBeenCalledOnce();

    await batcher.flush();
    expect(sink).toHaveBeenCalledTimes(1);

    await batcher.dispose();
  });

  it("does not call sink when buffer is empty", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink, 1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(sink).not.toHaveBeenCalled();

    await batcher.dispose();
  });

  it("fires repeatedly at each interval", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink, 1000);

    batcher.push(["a"]);
    await vi.advanceTimersByTimeAsync(1000);

    batcher.push(["b"]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, "a");
    expect(sink).toHaveBeenNthCalledWith(2, "b");

    await batcher.dispose();
  });
});

// ---------------------------------------------------------------
// Group 4: Manual Flush
// ---------------------------------------------------------------

describe("manual flush", () => {
  it("drains buffer and calls sink", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["manual line"]);
    await batcher.flush();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("manual line");

    await batcher.dispose();
  });

  it("does not call sink on empty buffer", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    await batcher.flush();

    expect(sink).not.toHaveBeenCalled();

    await batcher.dispose();
  });

  it("clears buffer so subsequent flush is a no-op", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["data"]);
    await batcher.flush();
    await batcher.flush();

    expect(sink).toHaveBeenCalledTimes(1);

    await batcher.dispose();
  });

  it("returns a promise", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["async test"]);
    const result = batcher.flush();

    expect(result).toBeInstanceOf(Promise);
    await result;

    await batcher.dispose();
  });
});

// ---------------------------------------------------------------
// Group 5: Dispose / Cleanup
// ---------------------------------------------------------------

describe("dispose and cleanup", () => {
  it("stops the auto-flush interval", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn().mockResolvedValue(undefined);
      const batcher = createStderrBatcher(sink, 1000);

      batcher.push(["pre-dispose"]);
      await batcher.dispose();

      expect(sink).toHaveBeenCalledOnce();

      sink.mockClear();
      await vi.advanceTimersByTimeAsync(2000);

      expect(sink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes remaining buffer before stopping", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    batcher.push(["remaining"]);
    await batcher.dispose();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("remaining");
  });

  it("does not call sink on empty buffer", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const batcher = createStderrBatcher(sink);

    await batcher.dispose();

    expect(sink).not.toHaveBeenCalled();
  });
});
