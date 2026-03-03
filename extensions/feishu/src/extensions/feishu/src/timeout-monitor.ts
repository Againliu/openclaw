import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { sendMessageFeishu } from "./send.js";

export interface PendingMessage {
  messageId: string;
  chatId: string;
  receivedAt: number;
  processingStartedAt?: number;
  notifiedQueue?: boolean;
  notifiedTimeout?: boolean;
  accountId?: string;
}

const pendingMessages = new Map<string, PendingMessage>();

// 默认超时阈值配置
// 5分钟未开始 -> 排队提示
const QUEUE_NOTIFY_MS = 5 * 60 * 1000;
// 15分钟未完成 -> 超时提示
const TIMEOUT_NOTIFY_MS = 15 * 60 * 1000;

let monitorInterval: NodeJS.Timeout | null = null;

export function registerPendingMessage(messageId: string, chatId: string, accountId?: string) {
  pendingMessages.set(messageId, {
    messageId,
    chatId,
    accountId,
    receivedAt: Date.now(),
  });
}

export function markProcessingStarted(messageId: string) {
  const pending = pendingMessages.get(messageId);
  if (pending) {
    pending.processingStartedAt = Date.now();
  }
}

export function removePendingMessage(messageId: string) {
  pendingMessages.delete(messageId);
}

export function startTimeoutMonitor(cfg: ClawdbotConfig, log?: (msg: string) => void) {
  if (monitorInterval) {
    return;
  }

  // 每分钟检查一次
  monitorInterval = setInterval(async () => {
    const now = Date.now();

    for (const [messageId, pending] of pendingMessages) {
      const elapsed = now - pending.receivedAt;

      // 5分钟未开始处理
      if (!pending.processingStartedAt && elapsed > QUEUE_NOTIFY_MS && !pending.notifiedQueue) {
        log?.(`feishu: sending queue notification for ${messageId}`);
        try {
          await sendMessageFeishu({
            cfg,
            to: pending.chatId,
            text: "⏳ 系统正在处理较多请求，您的消息已进入队列，请稍候...",
            replyToMessageId: messageId,
            accountId: pending.accountId,
          });
          pending.notifiedQueue = true;
        } catch (err) {
          log?.(`feishu: failed to send queue notification: ${String(err)}`);
        }
      }

      // 15分钟未完成
      if (elapsed > TIMEOUT_NOTIFY_MS && !pending.notifiedTimeout) {
        log?.(`feishu: sending timeout notification for ${messageId}`);
        try {
          await sendMessageFeishu({
            cfg,
            to: pending.chatId,
            text: "⚠️ 抱歉，处理您的请求时间较长，可能遇到了复杂的任务或系统繁忙。请耐心等待，或换个思路重新尝试发送。",
            replyToMessageId: messageId,
            accountId: pending.accountId,
          });
          pending.notifiedTimeout = true;
        } catch (err) {
          log?.(`feishu: failed to send timeout notification: ${String(err)}`);
        }
      }
    }
  }, 60 * 1000);
}

export function stopTimeoutMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
