import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredMessage {
  id: number;
  /** 进入上下文的序号,0 表示还没进入(没被模型处理过) */
  inc?: number;
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
  summarized_upto INTEGER NOT NULL DEFAULT 0,
  /** 已经进入模型对话轮次的最大 messages.id */
  llm_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  space     TEXT NOT NULL,
  first_row INTEGER NOT NULL,
  last_row  INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  messages  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_space ON turns(space, id);

CREATE TABLE IF NOT EXISTS memories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject);
`;

export interface SpaceRow {
  space: string;
  title: string;
  summary: string;
  summarizedUpto: number;
  llmCursor: number;
  /** 摘要已经覆盖到的 inc */
  summarizedInc: number;
}

export interface Memory {
  id: number;
  /** global | user:<qq> | space:<id> */
  subject: string;
  content: string;
  ts: number;
}

/**
 * 数据库结构升级:MIGRATIONS[i] 把库从版本 BASE_VERSION+i 升到 BASE_VERSION+i+1。
 * 以后要改表结构(加列等),只往这个数组末尾追加一条 SQL,更新时会自动执行,旧数据不丢。
 */
export const MIGRATIONS: string[] = [
  // v1 -> v2:消息按「进入上下文的先后」排序(inc),0 表示还没进入上下文;整理摘要的位置也改用 inc 记录
  `ALTER TABLE messages ADD COLUMN inc INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE spaces ADD COLUMN summarized_inc INTEGER NOT NULL DEFAULT 0;
   UPDATE messages SET inc = id WHERE role = 'self' OR id <= COALESCE((SELECT llm_cursor FROM spaces WHERE spaces.space = messages.space), 0);
   UPDATE spaces SET summarized_inc = summarized_upto;
   CREATE INDEX IF NOT EXISTS idx_messages_inc ON messages(space, inc);`,
];
const BASE_VERSION = 1;

export function runMigrations(raw: Database, migrations: string[] = MIGRATIONS, base = BASE_VERSION): number {
  let v = (raw.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v === 0) v = base; // 全新的库,或这个机制出现之前的旧库:表结构都是基线版本
  if (v > base + migrations.length) throw new Error(`数据库版本 ${v} 比程序支持的新,请先更新程序`);
  for (; v - base < migrations.length; v++) raw.exec(migrations[v - base]!);
  raw.exec(`PRAGMA user_version = ${v}`);
  return v;
}

export class Db {
  readonly raw: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec(SCHEMA);
    runMigrations(this.raw);
  }

  close() {
    this.raw.close();
  }

  /** 写入消息;同一空间内重复的 msg_id 会被忽略。返回是否为新消息 */
  addMessage(m: NewMessage): boolean {
    const r = this.raw
      .query(
        `INSERT OR IGNORE INTO messages (space, msg_id, ts, sender_id, sender_name, role, text, inc)
         VALUES ($space, $msgId, $ts, $senderId, $senderName, $role, $text,
                 CASE WHEN $role = 'self' THEN (SELECT COALESCE(MAX(inc), 0) + 1 FROM messages) ELSE 0 END)`,
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

  /** 还没被模型处理过的他人消息(含系统通知),按到达顺序 */
  unseen(space: string, limit = 500): StoredMessage[] {
    const rows = this.raw
      .query(
        `SELECT id, inc, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
         FROM messages WHERE space = $space AND inc = 0 AND role = 'user' ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $space: space, $limit: limit }) as StoredMessage[];
    return rows.reverse();
  }

  unseenCount(space: string): number {
    const r = this.raw.query("SELECT COUNT(*) AS n FROM messages WHERE space = $space AND inc = 0 AND role = 'user'").get({ $space: space }) as { n: number };
    return r.n;
  }

  /** 把这些消息并入上下文(按 id 顺序依次分配 inc);已经并入的会被跳过 */
  markIncluded(ids: number[]) {
    const stmt = this.raw.query("UPDATE messages SET inc = (SELECT COALESCE(MAX(inc), 0) + 1 FROM messages) WHERE id = $id AND inc = 0");
    for (const id of [...ids].sort((a, b) => a - b)) stmt.run({ $id: id });
  }

  /** 已并入上下文、且还没被摘要覆盖的消息,按并入顺序 */
  included(space: string): StoredMessage[] {
    return this.raw
      .query(
        `SELECT m.id, m.inc, m.space, m.msg_id AS msgId, m.ts, m.sender_id AS senderId, m.sender_name AS senderName, m.role, m.text
         FROM messages m LEFT JOIN spaces s ON s.space = m.space
         WHERE m.space = $space AND m.inc > 0 AND m.inc > COALESCE(s.summarized_inc, 0) ORDER BY m.inc`,
      )
      .all({ $space: space }) as StoredMessage[];
  }

  includedCount(space: string): number {
    const r = this.raw
      .query(
        `SELECT COUNT(*) AS n FROM messages m LEFT JOIN spaces s ON s.space = m.space
         WHERE m.space = $space AND m.inc > 0 AND m.inc > COALESCE(s.summarized_inc, 0)`,
      )
      .get({ $space: space }) as { n: number };
    return r.n;
  }

  /** 用于排序会话块:该会话最近一条已并入消息的 inc,没有则为 0 */
  lastInc(space: string): number {
    const r = this.raw.query("SELECT COALESCE(MAX(inc), 0) AS n FROM messages WHERE space = $space").get({ $space: space }) as { n: number };
    return r.n;
  }

  /** 有内容要放进上下文的会话:有已并入的消息,或有摘要 */
  contextSpaces(): SpaceRow[] {
    return this.raw
      .query(
        `SELECT s.space, s.title, s.summary, s.summarized_upto AS summarizedUpto, s.llm_cursor AS llmCursor, s.summarized_inc AS summarizedInc
         FROM spaces s
         WHERE s.summary != '' OR EXISTS (SELECT 1 FROM messages m WHERE m.space = s.space AND m.inc > s.summarized_inc)
         ORDER BY s.space`,
      )
      .all() as SpaceRow[];
  }

  /** 摘要覆盖到某个 inc 之前的内容 */
  setSummaryInc(space: string, summary: string, uptoInc: number) {
    this.getSpace(space);
    this.raw.query("UPDATE spaces SET summary = $summary, summarized_inc = $upto WHERE space = $space").run({ $space: space, $summary: summary, $upto: uptoInc });
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

  getSpace(space: string): SpaceRow {
    this.raw.query("INSERT OR IGNORE INTO spaces (space) VALUES ($space)").run({ $space: space });
    return this.raw
      .query(
        "SELECT space, title, summary, summarized_upto AS summarizedUpto, llm_cursor AS llmCursor, summarized_inc AS summarizedInc FROM spaces WHERE space = $space",
      )
      .get({ $space: space }) as SpaceRow;
  }

  setTitle(space: string, title: string) {
    this.getSpace(space);
    this.raw.query("UPDATE spaces SET title = $title WHERE space = $space").run({ $space: space, $title: title });
  }

  setSummary(space: string, summary: string, upto: number) {
    this.getSpace(space);
    this.raw
      .query("UPDATE spaces SET summary = $summary, summarized_upto = $upto WHERE space = $space")
      .run({ $space: space, $summary: summary, $upto: upto });
  }

  setCursor(space: string, rowId: number) {
    this.getSpace(space);
    this.raw.query("UPDATE spaces SET llm_cursor = $c WHERE space = $space").run({ $space: space, $c: rowId });
  }

  maxRowId(space: string): number {
    const r = this.raw.query("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE space = $space").get({ $space: space }) as { n: number };
    return r.n;
  }

  /** 游标之后的消息,最多取最新的 limit 条,按时间正序 */
  messagesAfter(space: string, afterRow: number, limit: number): StoredMessage[] {
    const rows = this.raw
      .query(
        `SELECT id, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
         FROM messages WHERE space = $space AND id > $after ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $space: space, $after: afterRow, $limit: limit }) as StoredMessage[];
    return rows.reverse();
  }

  /** 空间内第 n 新的消息的 id;不足 n 条时返回 0 */
  nthRecentId(space: string, n: number): number {
    const r = this.raw
      .query("SELECT id FROM messages WHERE space = $space ORDER BY id DESC LIMIT 1 OFFSET $off")
      .get({ $space: space, $off: n - 1 }) as { id: number } | null;
    return r?.id ?? 0;
  }

  messagesBetween(space: string, afterRow: number, uptoRow: number): StoredMessage[] {
    return this.raw
      .query(
        `SELECT id, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
         FROM messages WHERE space = $space AND id > $after AND id <= $upto ORDER BY id`,
      )
      .all({ $space: space, $after: afterRow, $upto: uptoRow }) as StoredMessage[];
  }

  findByMsgId(space: string, msgId: number): StoredMessage | null {
    return (
      (this.raw
        .query(
          `SELECT id, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
           FROM messages WHERE space = $space AND msg_id = $msgId`,
        )
        .get({ $space: space, $msgId: msgId }) as StoredMessage | null) ?? null
    );
  }

  /** 跨空间搜索聊天记录(关键词子串匹配),最新的在前 */
  searchMessages(query: string, opts: { space?: string; limit?: number } = {}): StoredMessage[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.raw
      .query(
        `SELECT id, space, msg_id AS msgId, ts, sender_id AS senderId, sender_name AS senderName, role, text
         FROM messages WHERE text LIKE $like ESCAPE '\\' AND ($space IS NULL OR space = $space)
         ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $like: like, $space: opts.space ?? null, $limit: opts.limit ?? 20 }) as StoredMessage[];
  }

  addTurn(space: string, firstRow: number, lastRow: number, messages: unknown[]) {
    this.raw
      .query("INSERT INTO turns (space, first_row, last_row, ts, messages) VALUES ($space, $f, $l, $ts, $m)")
      .run({ $space: space, $f: firstRow, $l: lastRow, $ts: Math.floor(Date.now() / 1000), $m: JSON.stringify(messages) });
  }

  turns<T = unknown>(space: string): T[][] {
    const rows = this.raw.query("SELECT messages FROM turns WHERE space = $space ORDER BY id").all({ $space: space }) as { messages: string }[];
    return rows.map((r) => JSON.parse(r.messages) as T[]);
  }

  /** 只保留某个空间最新的 keep 个对话轮次 */
  trimTurns(space: string, keep: number) {
    this.raw
      .query("DELETE FROM turns WHERE space = $space AND id NOT IN (SELECT id FROM turns WHERE space = $space ORDER BY id DESC LIMIT $keep)")
      .run({ $space: space, $keep: keep });
  }

  deleteTurnsUpto(space: string, rowId: number) {
    this.raw.query("DELETE FROM turns WHERE space = $space AND last_row <= $row").run({ $space: space, $row: rowId });
  }

  addMemory(subject: string, content: string): number {
    const r = this.raw
      .query("INSERT INTO memories (subject, content, ts) VALUES ($subject, $content, $ts)")
      .run({ $subject: subject, $content: content, $ts: Math.floor(Date.now() / 1000) });
    return Number(r.lastInsertRowid);
  }

  deleteMemory(id: number): boolean {
    return this.raw.query("DELETE FROM memories WHERE id = $id").run({ $id: id }).changes > 0;
  }

  memoriesFor(subjects: string[]): Memory[] {
    if (!subjects.length) return [];
    const marks = subjects.map((_, i) => `$s${i}`).join(",");
    const params = Object.fromEntries(subjects.map((s, i) => [`$s${i}`, s]));
    return this.raw.query(`SELECT id, subject, content, ts FROM memories WHERE subject IN (${marks}) ORDER BY id`).all(params) as Memory[];
  }

  searchMemories(query: string, limit = 20): Memory[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.raw
      .query("SELECT id, subject, content, ts FROM memories WHERE content LIKE $like ESCAPE '\\' ORDER BY id DESC LIMIT $limit")
      .all({ $like: like, $limit: limit }) as Memory[];
  }

  memoryChars(): number {
    const r = this.raw.query("SELECT COALESCE(SUM(LENGTH(content) + LENGTH(subject) + 12), 0) AS n FROM memories").get() as { n: number };
    return r.n;
  }

  /** 整理记忆:旧的整批归档,换成整理后的新条目 */
  replaceMemories(entries: Array<{ subject: string; content: string }>) {
    this.raw.exec("CREATE TABLE IF NOT EXISTS memories_archive (id INTEGER, subject TEXT, content TEXT, ts INTEGER, archived INTEGER)");
    const tx = this.raw.transaction(() => {
      this.raw.exec(`INSERT INTO memories_archive SELECT id, subject, content, ts, ${Math.floor(Date.now() / 1000)} FROM memories`);
      this.raw.exec("DELETE FROM memories");
      for (const e of entries) this.addMemory(e.subject, e.content);
    });
    tx();
  }

  allMemories(): Memory[] {
    return this.raw.query("SELECT id, subject, content, ts FROM memories ORDER BY id").all() as Memory[];
  }

  otherSpaceSummaries(exclude: string): Array<{ space: string; title: string; summary: string }> {
    return this.raw
      .query("SELECT space, title, summary FROM spaces WHERE space != $space AND summary != '' ORDER BY space")
      .all({ $space: exclude }) as Array<{ space: string; title: string; summary: string }>;
  }
}
