import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedMessage, ChannelRef } from "../../src/adapters/types.js";
import type { RecipeConfig, OrchestratorConfig, StageDefinition } from "../../src/recipes/types.js";
import type { GateRouter } from "../../src/gates/router.js";
import {
  initRecipeRouter,
  detectCollisions,
} from "../../src/recipes/router.js";

// -------------------------------------------------------------------
// Shared helpers and fixtures
// -------------------------------------------------------------------

/** Minimal orchestrator config for test recipes. */
function makeOrchestrator(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    role: "roles/orchestrator.md",
    backend: "cli-claude",
    model: "anthropic/claude-sonnet-4-20250514",
    effort: "high",
    timeout_ms: 30000,
    max_stage_retries: 3,
    max_total_actions: 10,
    ...overrides,
  };
}

/** Minimal stage definition for test recipes. */
function makeStage(overrides?: Partial<StageDefinition>): StageDefinition {
  return {
    role: "roles/stage.md",
    objective: "Test objective",
    inputs: [],
    outputs: [],
    allowed_transitions: [],
    allowed_scripts: [],
    ...overrides,
  };
}

/** Factory for minimal valid RecipeConfig with optional overrides. */
function makeRecipeConfig(overrides?: Partial<RecipeConfig>): RecipeConfig {
  return {
    id: "test-recipe",
    name: "Test Recipe",
    command: "/test-recipe",
    description: "A test recipe",
    orchestrator: makeOrchestrator(),
    stage_order: ["planning"],
    start_stage: "planning",
    stages: { planning: makeStage() },
    ...overrides,
  };
}

/** Build a NormalizedMessage with sensible defaults. */
function makeMessage(
  command: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    command,
    payload: { description: "test payload" },
    channel: { platform: "slack", channelId: "C123" },
    requestedBy: "U456",
    timestamp: new Date(),
    ...overrides,
  };
}

/** Build a minimal GateRouter stub that matches a fixed set of commands. */
function makeGateRouter(commands: string[]): GateRouter {
  const commandSet = new Set(commands);
  return {
    match(command: string) {
      if (commandSet.has(command)) {
        return {
          gate: {
            id: `gate-for-${command.slice(1)}`,
            name: `Gate for ${command}`,
            command,
            description: `Stub gate for ${command}`,
          },
          input: { required: [] },
          workflow: { steps: ["work"] },
          steps: {
            work: {
              execution: {
                type: "agent" as const,
                config: {
                  model: "anthropic/claude-sonnet-4-20250514",
                  tools: ["read"],
                  timeoutMs: 60000,
                },
              },
            },
          },
        };
      }
      return null;
    },
    createTask() {
      return null;
    },
  };
}

// -------------------------------------------------------------------
// Group 1: Recipe Router Initialization
// -------------------------------------------------------------------

describe("recipe router initialization", () => {
  it("initializes with recipes and exposes match/createTask methods", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set("alpha", makeRecipeConfig({ id: "alpha", command: "/alpha" }));

    const router = initRecipeRouter(recipes);

    expect(typeof router.match).toBe("function");
    expect(typeof router.createTask).toBe("function");
  });

  it("initializes with empty recipes map without error", () => {
    const recipes = new Map<string, RecipeConfig>();

    const router = initRecipeRouter(recipes);

    expect(router.match("/anything")).toBeNull();
  });
});

// -------------------------------------------------------------------
// Group 2: Command Matching
// -------------------------------------------------------------------

describe("command matching", () => {
  it("matches incoming command to the correct recipe config", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "new-implementation",
      makeRecipeConfig({
        id: "new-implementation",
        command: "/new-implementation",
        name: "New Implementation",
      }),
    );

    const router = initRecipeRouter(recipes);
    const result = router.match("/new-implementation");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("new-implementation");
    expect(result!.command).toBe("/new-implementation");
  });

  it("returns null for unknown commands", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set("alpha", makeRecipeConfig({ id: "alpha", command: "/alpha" }));

    const router = initRecipeRouter(recipes);

    expect(router.match("/nonexistent")).toBeNull();
  });

  it("matches multiple distinct recipe commands", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set("alpha", makeRecipeConfig({ id: "alpha", command: "/alpha" }));
    recipes.set("beta", makeRecipeConfig({ id: "beta", command: "/beta" }));

    const router = initRecipeRouter(recipes);

    const matchAlpha = router.match("/alpha");
    const matchBeta = router.match("/beta");

    expect(matchAlpha).not.toBeNull();
    expect(matchAlpha!.id).toBe("alpha");
    expect(matchBeta).not.toBeNull();
    expect(matchBeta!.id).toBe("beta");
  });
});

// -------------------------------------------------------------------
// Group 3: Task Creation
// -------------------------------------------------------------------

describe("task creation", () => {
  it("creates a Task object from matched recipe and NormalizedMessage", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "alpha",
      makeRecipeConfig({ id: "alpha", command: "/alpha" }),
    );

    const router = initRecipeRouter(recipes);

    const channel: ChannelRef = {
      platform: "slack",
      channelId: "C999",
      threadTs: "1234.5678",
    };
    const message = makeMessage("/alpha", {
      payload: { description: "build a feature" },
      channel,
      requestedBy: "U789",
    });

    const task = router.createTask(message);

    expect(task).not.toBeNull();
    expect(task!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(task!.gate).toBe("alpha");
    expect(task!.recipeId).toBe("alpha");
    expect(task!.status).toBe("queued");
    expect(task!.priority).toBe("normal");
    expect(task!.payload).toEqual({ description: "build a feature" });
    expect(task!.requestedBy).toBe("U789");
    expect(task!.sourceChannel).toEqual(channel);
    expect(task!.createdAt).toBeInstanceOf(Date);
    expect(task!.cost).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("returns null when creating task for unknown command", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "alpha",
      makeRecipeConfig({ id: "alpha", command: "/alpha" }),
    );

    const router = initRecipeRouter(recipes);
    const message = makeMessage("/unknown-command");
    const task = router.createTask(message);

    expect(task).toBeNull();
  });

  it("creates tasks with unique IDs for each invocation", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "alpha",
      makeRecipeConfig({ id: "alpha", command: "/alpha" }),
    );

    const router = initRecipeRouter(recipes);
    const message = makeMessage("/alpha");

    const task1 = router.createTask(message);
    const task2 = router.createTask(message);

    expect(task1).not.toBeNull();
    expect(task2).not.toBeNull();
    expect(task1!.id).not.toBe(task2!.id);
  });
});

// -------------------------------------------------------------------
// Group 4: Collision Detection
// -------------------------------------------------------------------

describe("collision detection", () => {
  it("detects recipe-gate collisions and returns disabled gate commands", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "shared",
      makeRecipeConfig({ id: "shared", command: "/shared" }),
    );
    const recipeRouter = initRecipeRouter(recipes);

    const gateRouter = makeGateRouter(["/shared"]);
    const mockLog = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const collisions = detectCollisions(recipeRouter, gateRouter, mockLog);

    expect(collisions.has("/shared")).toBe(true);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it("recipe wins over gate for shared commands", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "new-implementation",
      makeRecipeConfig({
        id: "new-implementation",
        command: "/new-implementation",
      }),
    );
    const recipeRouter = initRecipeRouter(recipes);

    const gateRouter = makeGateRouter(["/new-implementation"]);
    const mockLog = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const collisions = detectCollisions(recipeRouter, gateRouter, mockLog);

    // Recipe router still matches the shared command
    expect(recipeRouter.match("/new-implementation")).not.toBeNull();
    expect(collisions.has("/new-implementation")).toBe(true);
  });

  it("allows non-overlapping commands from both routers without warnings", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "recipe-only",
      makeRecipeConfig({ id: "recipe-only", command: "/recipe-cmd" }),
    );
    const recipeRouter = initRecipeRouter(recipes);

    const gateRouter = makeGateRouter(["/gate-cmd"]);
    const mockLog = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const collisions = detectCollisions(recipeRouter, gateRouter, mockLog);

    expect(collisions.size).toBe(0);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("throws hard error when two recipes claim the same command", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "recipe-a",
      makeRecipeConfig({ id: "recipe-a", command: "/shared-cmd" }),
    );
    recipes.set(
      "recipe-b",
      makeRecipeConfig({ id: "recipe-b", command: "/shared-cmd" }),
    );

    expect(() => initRecipeRouter(recipes)).toThrow();
  });
});

// -------------------------------------------------------------------
// Group 5: Router Excluded Commands
// -------------------------------------------------------------------

describe("router command accessor", () => {
  it("getCommands returns set of recipe-claimed commands", () => {
    const recipes = new Map<string, RecipeConfig>();
    recipes.set(
      "alpha",
      makeRecipeConfig({ id: "alpha", command: "/alpha" }),
    );
    recipes.set(
      "beta",
      makeRecipeConfig({ id: "beta", command: "/beta" }),
    );

    const router = initRecipeRouter(recipes);
    const commands = router.getCommands();

    expect(commands).toBeInstanceOf(Set);
    expect(commands.has("/alpha")).toBe(true);
    expect(commands.has("/beta")).toBe(true);
    expect(commands.size).toBe(2);
  });
});
