import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runScript } from "../../src/executor/script-runner.js";
import type { StepContext, StepOutput } from "../../src/runners/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Create a valid StepContext with sensible defaults and optional overrides. */
function makeStepContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    taskId: "task-001",
    taskPayload: { description: "test task" },
    gateId: "test-gate",
    stepId: "step-001",
    priorOutputs: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Stdin JSON Contract
// ---------------------------------------------------------------
describe("stdin JSON contract", () => {
  it("sends context as JSON to subprocess stdin", async () => {
    // The subprocess reads stdin, parses JSON, and echoes back the taskId field
    const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ctx=JSON.parse(d);process.stdout.write(JSON.stringify({output:ctx.taskPayload.description,output_files:[]}))})"`;
    const context = makeStepContext({
      taskPayload: { description: "stdin echo test" },
    });

    const result = await runScript(cmd, undefined, context);

    expect(result.output).toBe("stdin echo test");
    expect(result.exitCode).toBe(0);
  });

  it("maps StepContext fields to script contract format", async () => {
    // The subprocess reads stdin and echoes back the mapped field names
    const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ctx=JSON.parse(d);const fields=Object.keys(ctx).sort().join(',');process.stdout.write(JSON.stringify({output:ctx.workspace+'|'+JSON.stringify(ctx.steps),output_files:[]}))})"`;
    const priorOutput: StepOutput = {
      output: "prior result",
      outputFiles: [],
    };
    const context = makeStepContext({
      workspacePath: "/tmp/ws",
      priorOutputs: { "step-prev": priorOutput },
    });

    const result = await runScript(cmd, undefined, context);

    // workspace comes from workspacePath, steps maps priorOutputs stepId -> output string
    expect(result.output).toContain("/tmp/ws");
    expect(result.output).toContain("prior result");
  });
});

// ---------------------------------------------------------------
// Group 2: Stdout JSON Capture
// ---------------------------------------------------------------
describe("stdout JSON capture", () => {
  it("captures stdout JSON and maps to StepOutput", async () => {
    const cmd = `node -e "process.stdout.write(JSON.stringify({output:'result text',output_files:['a.md']}))"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.output).toBe("result text");
    expect(result.outputFiles).toEqual(["a.md"]);
    expect(result.exitCode).toBe(0);
  });

  it("captures optional cost field from stdout JSON", async () => {
    const cost = { totalTokens: 100, inputTokens: 60, outputTokens: 40, estimatedCostUsd: 0.01 };
    const cmd = `node -e "process.stdout.write(JSON.stringify({output:'with cost',output_files:[],cost:${JSON.stringify(cost)}}))"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.cost).toBeDefined();
    expect(result.cost!.totalTokens).toBe(100);
    expect(result.cost!.inputTokens).toBe(60);
    expect(result.cost!.outputTokens).toBe(40);
    expect(result.cost!.estimatedCostUsd).toBe(0.01);
  });

  it("handles invalid stdout JSON gracefully", async () => {
    const cmd = `node -e "process.stdout.write('not valid json')"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.output).toBeDefined();
    expect(typeof result.output).toBe("string");
  });
});

// ---------------------------------------------------------------
// Group 3: Stderr Streaming
// ---------------------------------------------------------------
describe("stderr streaming", () => {
  it("collects stderr lines without corrupting stdout parsing", async () => {
    const cmd = `node -e "process.stderr.write('progress line 1\\nprogress line 2\\n');process.stdout.write(JSON.stringify({output:'done',output_files:[]}))"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    // Stderr must not corrupt the stdout JSON parsing
    expect(result.output).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Group 4: Exit Code Handling
// ---------------------------------------------------------------
describe("exit code handling", () => {
  it("exit code 0 returns success StepOutput", async () => {
    const cmd = `node -e "process.stdout.write(JSON.stringify({output:'success',output_files:[]}))"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("success");
  });

  it("exit code 1 returns failed StepOutput with error", async () => {
    const cmd = `node -e "process.stderr.write('script failed');process.exit(1)"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("exit code 2 returns StepOutput with exitCode 2", async () => {
    const cmd = `node -e "process.exit(2)"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------
// Group 5: Timeout Enforcement
// ---------------------------------------------------------------
describe("timeout enforcement", () => {
  it("kills subprocess when timeout is exceeded", async () => {
    // Command that sleeps for 60 seconds, but we set a very short timeout
    const cmd = `node -e "setTimeout(()=>{},60000)"`;

    // runScript uses a default timeout, but we need a way to pass a short one.
    // The function signature is runScript(command, env, context) per RunnerDeps.
    // The implementation should support a configurable timeout for testing purposes.
    // We test with the exported function that accepts an optional timeout parameter.
    const { runScript: runScriptWithTimeout } = await import("../../src/executor/script-runner.js");
    const result = await runScriptWithTimeout(cmd, undefined, makeStepContext(), undefined, 500);

    expect(result.error).toBeDefined();
    expect(result.error!.toLowerCase()).toContain("timeout");
  }, 10_000);

  it("returns timeout StepOutput with proper structure", async () => {
    const cmd = `node -e "setTimeout(()=>{},60000)"`;

    const { runScript: runScriptWithTimeout } = await import("../../src/executor/script-runner.js");
    const result = await runScriptWithTimeout(cmd, undefined, makeStepContext(), undefined, 500);

    expect(result.output).toBe("");
    expect(result.outputFiles).toEqual([]);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  }, 10_000);
});

// ---------------------------------------------------------------
// Group 6: Environment Variables
// ---------------------------------------------------------------
describe("environment variables", () => {
  it("passes env variables to subprocess", async () => {
    const cmd = `node -e "process.stdout.write(JSON.stringify({output:process.env.CUSTOM_VAR,output_files:[]}))"`;
    const env = { CUSTOM_VAR: "hello-from-env" };

    const result = await runScript(cmd, env, makeStepContext());

    expect(result.output).toBe("hello-from-env");
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------
// Group 7: Uniform StepOutput Structure
// ---------------------------------------------------------------
describe("uniform StepOutput structure", () => {
  it("always returns StepOutput with required fields", async () => {
    // Success case
    const successCmd = `node -e "process.stdout.write(JSON.stringify({output:'ok',output_files:[]}))"`;
    const successResult = await runScript(successCmd, undefined, makeStepContext());
    expect(typeof successResult.output).toBe("string");
    expect(Array.isArray(successResult.outputFiles)).toBe(true);

    // Failure case
    const failCmd = `node -e "process.exit(1)"`;
    const failResult = await runScript(failCmd, undefined, makeStepContext());
    expect(typeof failResult.output).toBe("string");
    expect(Array.isArray(failResult.outputFiles)).toBe(true);

    // Timeout case
    const { runScript: runScriptWithTimeout } = await import("../../src/executor/script-runner.js");
    const timeoutCmd = `node -e "setTimeout(()=>{},60000)"`;
    const timeoutResult = await runScriptWithTimeout(timeoutCmd, undefined, makeStepContext(), undefined, 500);
    expect(typeof timeoutResult.output).toBe("string");
    expect(Array.isArray(timeoutResult.outputFiles)).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------
// Group 8: onStderr Callback
// ---------------------------------------------------------------
describe("onStderr callback", () => {
  it("invokes onStderr with stderr lines when callback is provided", async () => {
    const cmd = `node -e "process.stderr.write('warn-line-1\\nwarn-line-2\\n');process.stdout.write(JSON.stringify({output:'ok',output_files:[]}))"`;
    const onStderr = vi.fn();

    await runScript(cmd, undefined, makeStepContext(), onStderr);

    expect(onStderr).toHaveBeenCalled();
    // Collect all lines passed across invocations
    const allLines: string[] = onStderr.mock.calls.flatMap(
      (call: [string[]]) => call[0],
    );
    expect(allLines).toContain("warn-line-1");
    expect(allLines).toContain("warn-line-2");
  });

  it("does not crash when no onStderr callback is provided", async () => {
    const cmd = `node -e "process.stderr.write('some stderr\\n');process.stdout.write(JSON.stringify({output:'still works',output_files:[]}))"`;

    const result = await runScript(cmd, undefined, makeStepContext());

    expect(result.output).toBe("still works");
    expect(result.exitCode).toBe(0);
  });

  it("invokes onStderr for each stderr data chunk", async () => {
    // Two separate stderr writes with a small delay to produce distinct data events
    const cmd = `node -e "
      process.stderr.write('chunk-A\\n');
      setTimeout(() => {
        process.stderr.write('chunk-B\\n');
        setTimeout(() => {
          process.stdout.write(JSON.stringify({output:'done',output_files:[]}));
        }, 50);
      }, 50);
    "`;
    const collected: string[][] = [];
    const onStderr = (lines: string[]) => {
      collected.push([...lines]);
    };

    await runScript(cmd, undefined, makeStepContext(), onStderr);

    const allLines = collected.flat();
    expect(allLines).toContain("chunk-A");
    expect(allLines).toContain("chunk-B");
  });

  it("does not affect StepOutput structure when onStderr is provided", async () => {
    const cmd = `node -e "process.stderr.write('diag info\\n');process.stdout.write(JSON.stringify({output:'result-val',output_files:['f.md']}))"`;
    const onStderr = vi.fn();

    const result = await runScript(cmd, undefined, makeStepContext(), onStderr);

    expect(result.output).toBe("result-val");
    expect(result.outputFiles).toEqual(["f.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });
});
