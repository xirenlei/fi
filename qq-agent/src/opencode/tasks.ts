import type { Db } from "../memory/db";

export type TaskStatus = "running" | "done" | "error" | "aborted";

export interface OcTask {
  id: number;
  sessionId: string;
  /** 发起任务的聊天空间,完成后向这里汇报 */
  space: string;
  prompt: string;
  status: TaskStatus;
  result: string;
  created: number;
  finished: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oc_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  space      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL,
  result     TEXT NOT NULL DEFAULT '',
  created    INTEGER NOT NULL,
  finished   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oc_tasks_session ON oc_tasks(session_id, status);
`;

const COLS = "id, session_id AS sessionId, space, prompt, status, result, created, finished";

export class TaskStore {
  constructor(private db: Db) {
    db.raw.exec(SCHEMA);
  }

  create(sessionId: string, space: string, prompt: string): OcTask {
    const r = this.db.raw
      .query("INSERT INTO oc_tasks (session_id, space, prompt, status, created) VALUES ($s, $sp, $p, 'running', $t)")
      .run({ $s: sessionId, $sp: space, $p: prompt, $t: Math.floor(Date.now() / 1000) });
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): OcTask | null {
    return (this.db.raw.query(`SELECT ${COLS} FROM oc_tasks WHERE id = $id`).get({ $id: id }) as OcTask | null) ?? null;
  }

  running(): OcTask[] {
    return this.db.raw.query(`SELECT ${COLS} FROM oc_tasks WHERE status = 'running' ORDER BY id`).all() as OcTask[];
  }

  runningForSession(sessionId: string): OcTask | null {
    return (
      (this.db.raw
        .query(`SELECT ${COLS} FROM oc_tasks WHERE session_id = $s AND status = 'running' ORDER BY id DESC LIMIT 1`)
        .get({ $s: sessionId }) as OcTask | null) ?? null
    );
  }

  recent(limit = 10): OcTask[] {
    return this.db.raw.query(`SELECT ${COLS} FROM oc_tasks ORDER BY id DESC LIMIT $n`).all({ $n: limit }) as OcTask[];
  }

  finish(id: number, status: Exclude<TaskStatus, "running">, result: string) {
    this.db.raw
      .query("UPDATE oc_tasks SET status = $st, result = $r, finished = $t WHERE id = $id")
      .run({ $st: status, $r: result, $t: Math.floor(Date.now() / 1000), $id: id });
  }
}
