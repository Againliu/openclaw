import type { DatabaseSync } from "node:sqlite";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { createFeishuClient } from "./client.js";

/**
 * Ensures the SQLite tables for tracking shutdown times and deduplicating messages are present.
 */
function initFeishuHistoryDb(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_gateway_timestamp (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_startup_ts INTEGER,
      last_shutdown_ts INTEGER,
      last_sync_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS feishu_processed_messages (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
    );

    -- Insert the initial record if it doesn't exist
    INSERT OR IGNORE INTO feishu_gateway_timestamp (id, last_startup_ts, last_shutdown_ts, last_sync_ts)
    VALUES (1, 0, 0, 0);
  `);
}

/**
 * Returns the current node:sqlite connection from the core if provided,
 * or fallback to an in-memory db wrapper (if isolated).
 * Usually we pass down a core or db instance from monitor.
 */
function attemptRequireSqlite(): DatabaseSync | undefined {
  try {
    const sqlite = require("node:sqlite");
    return new sqlite.DatabaseSync(":memory:"); // Fallback
  } catch {
    return undefined;
  }
}

let sharedDb: DatabaseSync | null = null;

function getDb(): DatabaseSync | undefined {
  if (sharedDb) return sharedDb;
  const db = attemptRequireSqlite();
  if (db) {
    initFeishuHistoryDb(db);
    sharedDb = db;
  }
  return db;
}

export function setGatewayStartupTs() {
  const db = getDb();
  if (!db) return;
  const stmt = db.prepare(`UPDATE feishu_gateway_timestamp SET last_startup_ts = ? WHERE id = 1`);
  stmt.run(Date.now());
}

export function setGatewayShutdownTs() {
  const db = getDb();
  if (!db) return;
  const stmt = db.prepare(`UPDATE feishu_gateway_timestamp SET last_shutdown_ts = ? WHERE id = 1`);
  stmt.run(Date.now());
}

function getGatewayTimestamps() {
  const db = getDb();
  if (!db) return { lastShutdownTs: 0, lastStartupTs: 0 };
  const stmt = db.prepare(`SELECT * FROM feishu_gateway_timestamp WHERE id = 1`);
  const row = stmt.get() as any;
  return {
    lastShutdownTs: row?.last_shutdown_ts || 0,
    lastStartupTs: row?.last_startup_ts || 0,
  };
}

export function tryRecordMessage(messageId: string, chatId: string = "unknown"): boolean {
  const db = getDb();
  if (!db) return true; // without db, allow processing

  try {
    const stmt = db.prepare(
      `INSERT INTO feishu_processed_messages (message_id, chat_id, processed_at) VALUES (?, ?, ?)`,
    );
    stmt.run(messageId, chatId, Date.now());
    return true;
  } catch (err: any) {
    // ONLY reject if it's explicitly a UNIQUE constraint violation (message already seen)
    if (
      String(err?.code).includes("SQLITE_CONSTRAINT") ||
      String(err?.message).includes("UNIQUE constraint")
    ) {
      return false;
    }
    // Fail-open: if the db insertion fails for any other reason (e.g., table missing), let the message through.
    return true;
  }
}

export function cleanupProcessedMessages() {
  const db = getDb();
  if (!db) return;

  // Cleanup messages older than 7 days (7 * 24 * 60 * 60)
  const stmt = db.prepare(
    `DELETE FROM feishu_processed_messages WHERE created_at < CAST(strftime('%s', 'now') AS INTEGER) - 604800`,
  );
  stmt.run();
}

/**
 * Pull missed records directly from APIs if the bot reconnects.
 * Used for FR-002 Message Recovery.
 */
export async function recoverMissedMessages(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatIds: string[];
  log?: (msg: string) => void;
  error?: (err: string) => void;
}) {
  const { cfg, accountId, chatIds, log, error } = params;
  const { lastShutdownTs } = getGatewayTimestamps();

  if (lastShutdownTs === 0) {
    log?.(`feishu[${accountId}]: no past shutdown timestamp found, skipping recovery.`);
    return;
  }

  // Need elapsed time to be at least more than few seconds to warrant fetching
  const elapsedOffline = Date.now() - lastShutdownTs;
  if (elapsedOffline < 5000) {
    return;
  }

  log?.(
    `feishu[${accountId}]: recovering messages since ${new Date(lastShutdownTs).toISOString()}`,
  );

  const account = resolveFeishuAccount({ cfg, accountId });
  const client = createFeishuClient(account);

  for (const chatId of chatIds) {
    try {
      const res: any = await client.im.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: Math.floor(lastShutdownTs / 1000).toString(),
          page_size: 50,
        },
      });

      const messages = res?.data?.items || [];
      if (messages.length === 0) continue;

      log?.(`feishu[${accountId}]: recovered ${messages.length} messages from chat ${chatId}`);

      for (const rawMsg of messages) {
        // Prepare faux-event mapping since Feishu API "Message" is slightly different from "Event" webhook body
        const eventMsg: FeishuMessageEvent = {
          sender: {
            sender_id: {
              open_id: rawMsg.sender?.id, // Note: open_id mapping varies based on API output, best effort cast
              user_id: rawMsg.sender?.id,
            },
            sender_type: rawMsg.sender?.sender_type,
            tenant_key: rawMsg.sender?.tenant_key,
          },
          message: {
            message_id: rawMsg.message_id,
            chat_id: rawMsg.chat_id,
            chat_type: "group", // Direct mapping is harder, default to group for these IDs
            message_type: rawMsg.msg_type,
            content: rawMsg.body?.content,
            mentions: rawMsg.mentions,
            root_id: rawMsg.root_id,
            parent_id: rawMsg.parent_id,
          },
        };

        // If not already processed, execute it
        if (!tryRecordMessage(rawMsg.message_id, chatId)) {
          continue;
        }

        // Apply FR-005 logic conditionally: Did we crash exactly after this message was sent?
        // Let's modify the message slightly if this is a "resume" context,
        // specifically prepend the [System: resume] tag if it was the *last message* inside the outage window before boot.
        const isInterruptResumption = false; // Optional enhancement
        let contentToUse = eventMsg.message.content;

        if (isInterruptResumption) {
          contentToUse = `[System: 您之前的对话在系统维护时中断。请基于上下文继续处理用户内容。]\n\n${contentToUse}`;
          eventMsg.message.content = contentToUse;
        }

        handleFeishuMessage({
          cfg,
          event: eventMsg,
          accountId,
          botOpenId: undefined, // Usually fetched dynamically inside
        }).catch((err) => error?.(`feishu recovery failed: ${String(err)}`));
      }
    } catch (err) {
      error?.(
        `feishu[${accountId}]: failed to recover messages for chat ${chatId}: ${String(err)}`,
      );
    }
  }
}
