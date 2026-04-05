import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------
// Mock infrastructure for @slack/bolt
// ---------------------------------------------------------------

/** Captured command handler registrations keyed by command name. */
let capturedCommandHandlers: Map<string, Function>;

/** Captured event handler registrations keyed by event name. */
let capturedEventHandlers: Map<string, Function>;

/** Mock for app.client.chat.postMessage */
let mockPostMessage: ReturnType<typeof vi.fn>;

/** Mock for app.start() */
let mockStart: ReturnType<typeof vi.fn>;

/** Mock for app.stop() */
let mockStop: ReturnType<typeof vi.fn>;

/** Mock App constructor args captured for assertions */
let mockAppConstructorArgs: unknown[];

vi.mock("@slack/bolt", () => {
  const MockApp = vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    mockAppConstructorArgs = args;

    this.command = vi.fn((name: string | RegExp, handler: Function) => {
      const key = typeof name === "string" ? name : name.toString();
      capturedCommandHandlers.set(key, handler);
    });

    this.event = vi.fn((name: string, handler: Function) => {
      capturedEventHandlers.set(name, handler);
    });

    this.start = mockStart;
    this.stop = mockStop;

    this.client = {
      chat: {
        postMessage: mockPostMessage,
      },
    };
  });

  return { App: MockApp };
});

// Import modules under test (these do not exist yet -- expected to fail)
import { createSlackAdapter } from "../../src/adapters/slack.js";
import type { Adapter } from "../../src/adapters/adapter.js";
import type { NormalizedMessage, ChannelRef } from "../../src/adapters/types.js";

// ---------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------

/** Minimal config required by the SlackAdapter factory. */
const TEST_CONFIG = {
  botToken: "xoxb-test-bot-token",
  appToken: "xapp-test-app-token",
  signingSecret: "test-signing-secret",
};

/** Synthetic SlashCommand payload matching @slack/bolt SlashCommand shape. */
function makeSlashCommand(overrides: Record<string, unknown> = {}) {
  return {
    command: "/new-implementation",
    text: "implement feature X",
    user_id: "U12345",
    channel_id: "C67890",
    team_id: "T11111",
    response_url: "https://hooks.slack.com/commands/test",
    trigger_id: "trigger-123",
    ...overrides,
  };
}

/** Synthetic AppMentionEvent payload matching @slack/bolt event shape. */
function makeMentionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention" as const,
    user: "U12345",
    text: "<@UBOTID> continue",
    channel: "C67890",
    ts: "1234567890.123456",
    event_ts: "1234567890.123456",
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------

beforeEach(() => {
  capturedCommandHandlers = new Map();
  capturedEventHandlers = new Map();
  mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
  mockStart = vi.fn().mockResolvedValue(undefined);
  mockStop = vi.fn().mockResolvedValue(undefined);
  mockAppConstructorArgs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Group 1: Adapter Interface Contract
// ---------------------------------------------------------------
describe("adapter interface contract", () => {
  it("adapter module exports Adapter type that can be referenced", async () => {
    const mod = await import("../../src/adapters/adapter.js");
    expect(mod).toBeDefined();
  });

  it("Adapter interface requires connect, onMessage, sendReply, disconnect methods", () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendReply).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
  });
});

// ---------------------------------------------------------------
// Group 2: SlackAdapter Construction and Configuration
// ---------------------------------------------------------------
describe("SlackAdapter construction and configuration", () => {
  it("createSlackAdapter factory returns an adapter with all required methods", () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    expect(adapter).toBeDefined();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendReply).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
  });

  it("SlackAdapter configures Bolt App with Socket Mode and correct tokens", () => {
    createSlackAdapter(TEST_CONFIG);
    expect(mockAppConstructorArgs).toHaveLength(1);
    const opts = mockAppConstructorArgs[0] as Record<string, unknown>;
    expect(opts.socketMode).toBe(true);
    expect(opts.token).toBe("xoxb-test-bot-token");
    expect(opts.appToken).toBe("xapp-test-app-token");
  });
});

// ---------------------------------------------------------------
// Group 3: Slash Command Parsing
// ---------------------------------------------------------------
describe("slash command parsing", () => {
  it("slash command parsed into NormalizedMessage with gate command", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    // Find and invoke the captured command handler
    const handler = findCommandHandler();
    const ackFn = vi.fn();
    await handler({
      command: makeSlashCommand(),
      ack: ackFn,
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.command).toBe("/new-implementation");
    expect(msg.channel.platform).toBe("slack");
    expect(msg.channel.channelId).toBe("C67890");
    expect(msg.requestedBy).toBe("U12345");
    expect(msg.timestamp).toBeInstanceOf(Date);
  });

  it("slash command text parsed into payload", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    const handler = findCommandHandler();
    await handler({
      command: makeSlashCommand({ text: "implement wallet balance endpoint" }),
      ack: vi.fn(),
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].payload.text).toBe("implement wallet balance endpoint");
  });

  it("slash command with empty text produces valid NormalizedMessage", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    const handler = findCommandHandler();
    await handler({
      command: makeSlashCommand({ text: "" }),
      ack: vi.fn(),
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].payload.text).toBe("");
  });

  it("slash command ack() is called to prevent timeout", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    adapter.onMessage(() => {});

    await adapter.connect();

    const handler = findCommandHandler();
    const ackFn = vi.fn();
    await handler({
      command: makeSlashCommand(),
      ack: ackFn,
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(ackFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------
// Group 4: @bees Mention Parsing
// ---------------------------------------------------------------
describe("@bees mention parsing", () => {
  it("@bees mention parsed into NormalizedMessage", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    const handler = capturedEventHandlers.get("app_mention");
    expect(handler).toBeDefined();
    await handler!({
      event: makeMentionEvent(),
      say: vi.fn(),
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.requestedBy).toBe("U12345");
    expect(msg.channel.platform).toBe("slack");
    expect(msg.channel.channelId).toBe("C67890");
  });

  it("@bees mention in thread preserves thread_ts", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    const handler = capturedEventHandlers.get("app_mention");
    expect(handler).toBeDefined();
    await handler!({
      event: makeMentionEvent({ thread_ts: "1234567890.000000" }),
      say: vi.fn(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].channel.threadTs).toBe("1234567890.000000");
  });

  it("@bees mention strips bot mention prefix from text", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const received: NormalizedMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();

    const handler = capturedEventHandlers.get("app_mention");
    expect(handler).toBeDefined();
    await handler!({
      event: makeMentionEvent({ text: "<@UBOTID> run the implementation gate" }),
      say: vi.fn(),
    });

    expect(received).toHaveLength(1);
    const payloadText = received[0].payload.text as string;
    expect(payloadText).not.toMatch(/^<@/);
    expect(payloadText).toBe("run the implementation gate");
  });
});

// ---------------------------------------------------------------
// Group 5: sendReply
// ---------------------------------------------------------------
describe("sendReply", () => {
  it("sends message to channel without thread_ts when threadTs is absent", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    await adapter.connect();

    const channel: ChannelRef = {
      platform: "slack",
      channelId: "C67890",
    };

    await adapter.sendReply(channel, "reply text");

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const callArgs = mockPostMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.channel).toBe("C67890");
    expect(callArgs.text).toBe("reply text");
    expect(callArgs.thread_ts).toBeUndefined();
  });

  it("sends message to thread when threadTs is provided", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    await adapter.connect();

    const channel: ChannelRef = {
      platform: "slack",
      channelId: "C67890",
      threadTs: "1234567890.123456",
    };

    await adapter.sendReply(channel, "threaded reply");

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const callArgs = mockPostMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.channel).toBe("C67890");
    expect(callArgs.text).toBe("threaded reply");
    expect(callArgs.thread_ts).toBe("1234567890.123456");
  });

  it("handles Slack API failure with descriptive error", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    await adapter.connect();

    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));

    const channel: ChannelRef = {
      platform: "slack",
      channelId: "C99999",
    };

    await expect(adapter.sendReply(channel, "will fail")).rejects.toThrow(/C99999/);
  });
});

// ---------------------------------------------------------------
// Group 6: Connection Lifecycle
// ---------------------------------------------------------------
describe("connection lifecycle", () => {
  it("connect() calls App.start()", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    await adapter.connect();
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("disconnect() calls App.stop()", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    await adapter.connect();
    await adapter.disconnect();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("connect() wraps Slack connection failures with descriptive error", async () => {
    mockStart.mockRejectedValueOnce(new Error("websocket_error"));

    const adapter = createSlackAdapter(TEST_CONFIG);
    await expect(adapter.connect()).rejects.toThrow(/[Ss]lack|[Ss]ocket/);
  });
});

// ---------------------------------------------------------------
// Group 7: Edge Cases and Listener Management
// ---------------------------------------------------------------
describe("listener management", () => {
  it("onMessage registers callback that receives parsed messages", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const callback = vi.fn();
    adapter.onMessage(callback);

    await adapter.connect();

    const handler = findCommandHandler();
    await handler({
      command: makeSlashCommand(),
      ack: vi.fn(),
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(callback).toHaveBeenCalledOnce();
    const msg = callback.mock.calls[0][0] as NormalizedMessage;
    expect(msg.command).toBe("/new-implementation");
  });

  it("multiple onMessage listeners all receive events", async () => {
    const adapter = createSlackAdapter(TEST_CONFIG);
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    adapter.onMessage(callback1);
    adapter.onMessage(callback2);

    await adapter.connect();

    const handler = findCommandHandler();
    await handler({
      command: makeSlashCommand(),
      ack: vi.fn(),
      say: vi.fn(),
      respond: vi.fn(),
    });

    expect(callback1).toHaveBeenCalledOnce();
    expect(callback2).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

/**
 * Locate the first captured command handler from the mock App.
 * Throws if no command handler has been registered.
 */
function findCommandHandler(): Function {
  if (capturedCommandHandlers.size === 0) {
    throw new Error("No command handlers were registered on the mock App");
  }
  return capturedCommandHandlers.values().next().value!;
}
