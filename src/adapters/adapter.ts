/**
 * Abstract adapter interface for multi-channel input abstraction.
 *
 * Defines the contract that all input adapters (Slack, future Telegram/Discord)
 * must implement. The adapter normalizes platform-specific events into
 * NormalizedMessage and routes replies back through platform APIs.
 *
 * @module adapters/adapter
 */

import type { NormalizedMessage, ChannelRef } from "./types.js";

/** Pluggable input adapter for receiving messages and sending replies. */
export interface Adapter {
  /** Adapter identifier (immutable after creation). */
  readonly name: string;
  /** Connect to the messaging platform. */
  connect(): Promise<void>;
  /** Disconnect from the messaging platform. */
  disconnect(): Promise<void>;
  /** Register a callback to receive normalized messages. */
  onMessage(callback: (message: NormalizedMessage) => void): void;
  /** Send a reply to a conversation channel or thread. */
  sendReply(channel: ChannelRef, text: string): Promise<void>;
}
