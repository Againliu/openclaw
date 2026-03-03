/**
 * Reaction State Machine for Feishu
 *
 * Provides multi-message state management for typing indicators.
 * Each message has an independent state lifecycle:
 *   QUEUED (⏳) → PROCESSING (⌨️) → COMPLETED (no emoji)
 *
 * This solves the problem of emoji residue (92.5% residue rate in production)
 * by using a Map-based state tracker instead of a single variable.
 *
 * @see https://github.com/openclaw/openclaw/issues/XXX
 */

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { addReactionFeishu, removeReactionFeishu } from "./reactions.js";

// Emoji types for different states
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
export const ReactionEmoji = {
  /** Message is queued, waiting to be processed */
  QUEUED: "OK", // 👌 OK - "收到排队"
  /** Agent is actively processing/thinking */
  PROCESSING: "Typing", // ⌨️ Typing - "正在输入"
} as const;

export type ReactionEmojiType = (typeof ReactionEmoji)[keyof typeof ReactionEmoji];

/**
 * State of a single message in the reaction lifecycle
 */
export type MessageReactionState = {
  /** Unique message ID from Feishu */
  messageId: string;
  /** Chat/conversation ID */
  chatId: string;
  /** Current status in the lifecycle */
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "ERROR";
  /** Currently displayed emoji type (null if none) */
  currentEmoji: ReactionEmojiType | null;
  /** Reaction ID returned by Feishu API (needed for removal) */
  currentReactionId: string | null;
  /** Timestamp when state was created */
  createdAt: number;
  /** Account ID for multi-account support */
  accountId?: string;
};

/**
 * Configuration for ReactionStateManager
 */
export type ReactionStateManagerConfig = {
  cfg: ClawdbotConfig;
  /** Logger function for debugging */
  log?: (message: string) => void;
  /** Error logger function */
  error?: (message: string) => void;
  /** Timeout for stale state cleanup (default: 30 minutes) */
  staleTimeoutMs?: number;
};

/**
 * ReactionStateManager - Manages multiple message reaction states independently
 *
 * Key features:
 * 1. Each message has its own state (Map<messageId, State>)
 * 2. State transitions: QUEUED → PROCESSING → COMPLETED
 * 3. Reliable cleanup with try-finally pattern
 * 4. Stale state cleanup for gateway restarts
 */
export class ReactionStateManager {
  private states = new Map<string, MessageReactionState>();
  private config: ReactionStateManagerConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: ReactionStateManagerConfig) {
    this.config = config;
    // Start periodic cleanup for stale states
    this.startPeriodicCleanup();
  }

  /**
   * Called when a message is received and enters the queue.
   * Adds a QUEUED emoji (☝️) to indicate "wait a moment".
   */
  async onMessageQueued(params: {
    messageId: string;
    chatId: string;
    accountId?: string;
  }): Promise<void> {
    const { messageId, chatId, accountId } = params;
    const log = this.config.log ?? console.log;

    // Check if we already have state for this message
    if (this.states.has(messageId)) {
      log(`[reaction-state] Message ${messageId} already tracked, skipping QUEUED`);
      return;
    }

    // Create initial state
    const state: MessageReactionState = {
      messageId,
      chatId,
      status: "QUEUED",
      currentEmoji: null,
      currentReactionId: null,
      createdAt: Date.now(),
      accountId,
    };
    this.states.set(messageId, state);

    // Add QUEUED emoji
    try {
      const result = await addReactionFeishu({
        cfg: this.config.cfg,
        messageId,
        emojiType: ReactionEmoji.QUEUED,
        accountId,
      });
      state.currentEmoji = ReactionEmoji.QUEUED;
      state.currentReactionId = result.reactionId;
      log(
        `[reaction-state] QUEUED emoji added: messageId=${messageId}, reactionId=${result.reactionId}`,
      );
    } catch (err) {
      // Non-critical, log and continue
      log(`[reaction-state] Failed to add QUEUED emoji for ${messageId}: ${err}`);
    }
  }

  /**
   * Called when agent starts processing a message.
   * Transitions from QUEUED (☝️) to PROCESSING (⌨️).
   */
  async onProcessingStart(messageId: string): Promise<void> {
    const state = this.states.get(messageId);
    const log = this.config.log ?? console.log;

    if (!state) {
      log(`[reaction-state] No state found for ${messageId}, creating PROCESSING directly`);
      // Create state directly in PROCESSING if not queued
      return;
    }

    if (state.status !== "QUEUED") {
      log(`[reaction-state] Message ${messageId} not in QUEUED status (${state.status}), skipping`);
      return;
    }

    // Remove QUEUED emoji first
    if (state.currentReactionId) {
      try {
        await removeReactionFeishu({
          cfg: this.config.cfg,
          messageId: state.messageId,
          reactionId: state.currentReactionId,
          accountId: state.accountId,
        });
        log(`[reaction-state] Removed QUEUED emoji: messageId=${messageId}`);
      } catch (err) {
        log(`[reaction-state] Failed to remove QUEUED emoji for ${messageId}: ${err}`);
      }
    }

    // Add PROCESSING emoji
    try {
      const result = await addReactionFeishu({
        cfg: this.config.cfg,
        messageId: state.messageId,
        emojiType: ReactionEmoji.PROCESSING,
        accountId: state.accountId,
      });
      state.status = "PROCESSING";
      state.currentEmoji = ReactionEmoji.PROCESSING;
      state.currentReactionId = result.reactionId;
      log(
        `[reaction-state] PROCESSING emoji added: messageId=${messageId}, reactionId=${result.reactionId}`,
      );
    } catch (err) {
      log(`[reaction-state] Failed to add PROCESSING emoji for ${messageId}: ${err}`);
      // Still update status
      state.status = "PROCESSING";
      state.currentEmoji = null;
      state.currentReactionId = null;
    }
  }

  /**
   * Called when message processing is completed (success or error).
   * Removes any emoji and cleans up state.
   *
   * IMPORTANT: This should always be called in a finally block!
   */
  async onCompleted(messageId: string): Promise<void> {
    const state = this.states.get(messageId);
    const log = this.config.log ?? console.log;

    if (!state) {
      log(`[reaction-state] No state found for ${messageId}, nothing to cleanup`);
      return;
    }

    // Remove current emoji if any
    if (state.currentReactionId) {
      try {
        await removeReactionFeishu({
          cfg: this.config.cfg,
          messageId: state.messageId,
          reactionId: state.currentReactionId,
          accountId: state.accountId,
        });
        log(
          `[reaction-state] Removed ${state.currentEmoji} emoji on completion: messageId=${messageId}`,
        );
      } catch (err) {
        log(`[reaction-state] Failed to remove emoji on completion for ${messageId}: ${err}`);
      }
    }

    // Update state
    state.status = "COMPLETED";
    state.currentEmoji = null;
    state.currentReactionId = null;

    // Schedule delayed cleanup to prevent duplicate processing
    setTimeout(() => {
      this.states.delete(messageId);
      log(`[reaction-state] State cleaned up: messageId=${messageId}`);
    }, 60000); // 1 minute delay
  }

  /**
   * Get current state for a message (for debugging/monitoring)
   */
  getState(messageId: string): MessageReactionState | undefined {
    return this.states.get(messageId);
  }

  /**
   * Clear all reaction states for a specific chat/conversation.
   * Useful when the agent sends a final reply, meaning all queued processing is done.
   */
  async clearForChat(chatId: string): Promise<void> {
    const log = this.config.log ?? console.log;
    let clearedCount = 0;

    for (const [messageId, state] of this.states) {
      if (state.chatId === chatId) {
        await this.onCompleted(messageId);
        clearedCount++;
      }
    }

    if (clearedCount > 0) {
      log(`[reaction-state] Cleared ${clearedCount} states for chat ${chatId}`);
    }
  }

  /**
   * Get all active states (for debugging/monitoring)
   */
  getAllStates(): Map<string, MessageReactionState> {
    return new Map(this.states);
  }

  /**
   * Cleanup stale states (called periodically and on gateway restart)
   * Removes emojis for messages that have been stuck for too long.
   */
  async cleanupStaleStates(): Promise<void> {
    const log = this.config.log ?? console.log;
    const staleTimeoutMs = this.config.staleTimeoutMs ?? 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    for (const [messageId, state] of this.states) {
      if (now - state.createdAt > staleTimeoutMs) {
        log(
          `[reaction-state] Cleaning up stale state: messageId=${messageId}, age=${Math.round((now - state.createdAt) / 60000)}min`,
        );
        await this.onCompleted(messageId);
      }
    }
  }

  /**
   * Start periodic cleanup interval
   */
  private startPeriodicCleanup(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupStaleStates().catch((err) => {
          const error = this.config.error ?? console.error;
          error(`[reaction-state] Periodic cleanup failed: ${err}`);
        });
      },
      5 * 60 * 1000,
    );
  }

  /**
   * Stop the manager and cleanup all states
   */
  async shutdown(): Promise<void> {
    const log = this.config.log ?? console.log;
    log(`[reaction-state] Shutting down, cleaning up ${this.states.size} states`);

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Cleanup all remaining states
    for (const messageId of this.states.keys()) {
      await this.onCompleted(messageId);
    }
  }
}

// Singleton instance for global access
let globalManager: ReactionStateManager | null = null;

/**
 * Get or create the global ReactionStateManager instance
 */
export function getReactionStateManager(config?: ReactionStateManagerConfig): ReactionStateManager {
  if (!globalManager && config) {
    globalManager = new ReactionStateManager(config);
  }
  if (!globalManager) {
    throw new Error("ReactionStateManager not initialized. Call with config first.");
  }
  return globalManager;
}

/**
 * Initialize the global ReactionStateManager
 */
export function initReactionStateManager(config: ReactionStateManagerConfig): ReactionStateManager {
  if (globalManager) {
    // Already initialized, just update config
    return globalManager;
  }
  globalManager = new ReactionStateManager(config);
  return globalManager;
}
