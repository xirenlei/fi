import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredMessage {
  id: number;
  space: string;
  msgId: number | null;
  ts: number;
  senderId: number;
  senderName: string;
  /** user 为他人消息,self 为 Agent 自己发出的 */
  role: "user" | "self";
  text: string;
}

export interface NewMessage {
  space: string;
  msgId: number | null;
  ts: number;
  senderId: number;
  senderName: string;
  role: "user" | "self";
  text: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  space       TEXT NOT NULL,
  msg_id      INTEGER,
  ts          INTEGER NOT NULL,
  sender_id   INTEGER NOT NULL,
  sender_name TEXT NOT NULL,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_space ON messages(space, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg ON messages(space, msg_id) WHERE msg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spaces (
  space   TEXT PRIMARY KEY,
  title   TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  /** 已被摘要覆盖的最大 messages.id */
  summarized_upto INTEGER NOT NULL DEFAULT 0
);
`;

export class Db {
  readonly raw: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec(SCHEMA);
  }

  close() {
    this.raw.close();
  }

  /** 写入消息;同一空间内重复的 msg_id 会被忽略。返回是否为新消息 */
  addMessage(m: NewMessage): boolean {
    const r = this.raw
      .query(
        `INSERT OR IGNORE INTO messages (space, msg_id, ts, sender_id, sender_name, role, text)
         VALUES ($space, $msgId, $ts, $senderId, $senderName, $role, $text)`,
      )
      .run({
        $space: m.space,
        $msgId: m.msgId,
        $ts: m.ts,
        $senderId: m.senderId,
        $senderName: m.senderName,
        $role: m.role,
        $text: m.text,
      });
    return r.changes > 0;
  }

  /** 最近 limit 条消息,按时间正序 */
  recent(space: string, limit: number): StoredMessage[] {
    const rows = this.raw
      .query(
        `SELECT id, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
         FROM messages WHERE space = $space ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $space: space, $limit: limit }) as StoredMessage[];
    return rows.reverse();
  }

  count(space: string): number {
    const r = this.raw.query("SELECT COUNT(*) AS n FROM messages WHERE space = $space").get({ $space: space }) as { n: number };
    return r.n;
  }

  listSpaces(): string[] {
    return (this.raw.query("SELECT DISTINCT space FROM messages").all() as { space: string }[]).map((r) => r.space);
  }
}
