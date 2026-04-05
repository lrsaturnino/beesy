/**
 * Input adapter abstraction types.
 *
 * These types represent the normalized input that any adapter (Slack, future
 * Telegram/Discord) produces. The NormalizedMessage carries everything the gate
 * router needs to create a Task. ChannelRef carries enough information to route
 * replies back to the originating conversation thread.
 *
 * @module adapters/types
 */

/** Reference to a conversation channel for routing replies. */
export interface ChannelRef {
  /** Platform identifier (e.g., "slack"). */
  platform: string;
  /** Platform-specific channel identifier. */
  channelId: string;
  /** Thread identifier for reply threading (optional, platform-specific). */
  threadTs?: string;
}

/** Normalized input produced by any adapter (Slack, future Telegram/Discord). */
export interface NormalizedMessage {
  /** The gate command (e.g., "/new-implementation"). */
  command: string;
  /** Parsed user input payload. */
  payload: Record<string, unknown>;
  /** Source conversation channel for reply routing. */
  channel: ChannelRef;
  /** User identifier who initiated the request. */
  requestedBy: string;
  /** Timestamp when the message was received. */
  timestamp: Date;
  /** Original platform event for debugging (optional). */
  rawEvent?: unknown;
}
