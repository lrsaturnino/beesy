/**
 * Slack Bolt adapter for receiving messages and sending replies via Socket Mode.
 *
 * Wraps the @slack/bolt App to normalize slash commands and @bees mentions into
 * NormalizedMessage objects. Sends replies to channels and threads via the
 * Slack chat.postMessage API.
 *
 * @module adapters/slack
 */

import { App } from "@slack/bolt";
import type { Adapter } from "./adapter.js";
import type { NormalizedMessage, ChannelRef } from "./types.js";
import { createLogger } from "../utils/logger.js";

/** Configuration required to create a SlackAdapter. */
export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
}

/**
 * Minimal shape of the Slack AppMentionEvent fields used by the adapter.
 * Avoids an unsafe `as unknown as Record<string, unknown>` double cast
 * while remaining decoupled from the full Bolt event type.
 */
interface MentionEventFields {
  text?: string;
  channel: string;
  user?: string;
  ts: string;
  thread_ts?: string;
}

/** Extract a human-readable message from an unknown caught error value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strip the bot mention prefix (e.g., "<@UBOTID> ") from message text. */
function stripBotMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, "");
}

/** Slack Bolt adapter implementing the Adapter interface. */
export class SlackAdapter implements Adapter {
  readonly name = "slack";
  private readonly app: App;
  private readonly listeners: Array<(message: NormalizedMessage) => void> = [];
  private readonly log = createLogger(process.env.LOG_LEVEL);

  constructor(config: SlackAdapterConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
  }

  /** Connect to Slack via Socket Mode, registering command and event handlers. */
  async connect(): Promise<void> {
    this.registerHandlers();
    try {
      await this.app.start();
      this.log.info("Slack adapter connected via Socket Mode");
    } catch (error) {
      const msg = errorMessage(error);
      this.log.error("Slack Socket Mode connection failed", { error: msg });
      throw new Error(`Failed to connect Slack Socket Mode: ${msg}`);
    }
  }

  /** Disconnect from Slack by stopping the Bolt App. */
  async disconnect(): Promise<void> {
    await this.app.stop();
    this.log.info("Slack adapter disconnected");
  }

  /** Register a listener invoked for every normalized message (command or mention). */
  onMessage(callback: (message: NormalizedMessage) => void): void {
    this.listeners.push(callback);
  }

  /** Send a text reply to a channel, threading when the ChannelRef has a threadTs. */
  async sendReply(channel: ChannelRef, text: string): Promise<void> {
    const args = {
      channel: channel.channelId,
      text,
      ...(channel.threadTs ? { thread_ts: channel.threadTs } : {}),
    } as Parameters<typeof this.app.client.chat.postMessage>[0];

    try {
      await this.app.client.chat.postMessage(args);
    } catch (error) {
      const msg = errorMessage(error);
      this.log.error("Failed to send Slack reply", {
        channel: channel.channelId,
        threadTs: channel.threadTs,
        error: msg,
      });
      throw new Error(
        `Failed to send reply to channel ${channel.channelId}: ${msg}`,
      );
    }
  }

  /** Register slash command and mention event handlers on the Bolt App. */
  private registerHandlers(): void {
    // Catch-all slash command handler
    this.app.command(/.*/, async ({ command, ack }) => {
      await ack();
      const normalized: NormalizedMessage = {
        command: command.command,
        payload: { text: command.text },
        channel: {
          platform: "slack",
          channelId: command.channel_id,
        },
        requestedBy: command.user_id,
        timestamp: new Date(),
        rawEvent: command,
      };
      this.notifyListeners(normalized);
    });

    // App mention event handler
    this.app.event("app_mention", async ({ event }) => {
      const mention = event as unknown as MentionEventFields;
      const normalized: NormalizedMessage = {
        command: "@bees",
        payload: { text: stripBotMention(mention.text ?? "") },
        channel: {
          platform: "slack",
          channelId: mention.channel,
          threadTs: mention.thread_ts ?? mention.ts,
        },
        requestedBy: mention.user ?? "unknown",
        timestamp: new Date(),
        rawEvent: mention,
      };
      this.notifyListeners(normalized);
    });
  }

  /** Invoke all registered message listeners with the given message. */
  private notifyListeners(message: NormalizedMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

/** Factory function to create a SlackAdapter for dependency injection. */
export function createSlackAdapter(config: SlackAdapterConfig): Adapter {
  return new SlackAdapter(config);
}
