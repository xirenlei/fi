import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../memory/db";

export type JobStatus = "running" | "done" | "error" | "aborted";

export interface Job {
  id: number;
  /** 启动它的聊天空间,结束后向这里汇报;自己在自由时间启动的是 "self" */
  space: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  pid: number | null;
  timeoutS: number;
  result: string;
  created: number;
  finished: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  space     TEXT NOT NULL,
  command   TEXT NOT NULL,
  status    TEXT NOT NULL,
  exit_code INTEGER,
  pid       INTEGER,
  timeout_s INTEGER NOT NULL,
  result    TEXT NOT NULL DEFAULT '',
  created   INTEGER NOT NULL,
  finished  INTEGER
);
`;

const COLS = "id, space, command, status, exit_code AS exitCode, pid, timeout_s AS timeoutS, result, created, finished";
const RESULT_CHARS = 3000;
const POLL_MS = 2000;
const KEEP_LOG_DAYS = 14;

const now = () => Math.floor(Date.now() / 1000);
/** 去掉终端颜色等控制序列,OpenCode 的输出里有不少 */
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

export class JobStore {
  constructor(private db: Db) {
    db.raw.exec(SCHEMA);
  }
  create(space: string, command: string, timeoutS: number): Job {
    const r = this.db.raw
      .query("INSERT INTO jobs (space, command, status, timeout_s, created) VALUES ($sp, $c, 'running', $t, $now)")
      .run({ $sp: space, $c: command, $t: timeoutS, $now: now() });
    return this.get(Number(r.lastInsertRowid))!;
  }
  get(id: number): Job | null {
    return (this.db.raw.query(`SELECT ${COLS} FROM jobs WHERE id = $id`).get({ $id: id }) as Job | null) ?? null;
  }
  running(): Job[] {
    return this.db.raw.query(`SELECT ${COLS} FROM jobs WHERE status = 'running' ORDER BY id`).all() as Job[];
  }
  recent(limit = 10): Job[] {
    return this.db.raw.query(`SELECT ${COLS} FROM jobs ORDER BY id DESC LIMIT $n`).all({ $n: limit }) as Job[];
  }
  setPid(id: number, pid: number) {
    this.db.raw.query("UPDATE jobs SET pid = $p WHERE id = $id").run({ $p: pid, $id: id });
  }
  /** 只有还在运行的才会被收尾;返回是否真的改了(防止重复汇报) */
  finish(id: number, status: Exclude<JobStatus, "running">, exitCode: number | null, result: string): boolean {
    const r = this.db.raw
      .query("UPDATE jobs SET status = $st, exit_code = $c, result = $r, finished = $t WHERE id = $id AND status = 'running'")
      .run({ $st: status, $c: exitCode, $r: result, $t: now(), $id: id });
    return r.changes > 0;
  }
}

export interface JobDeps {
  store: JobStore;
  /** 日志和退出码文件放在这里 */
  dir: string;
  cwd: () => string;
  /** 额外注入的环境变量(例如给 OpenCode 用的密钥) */
  env: () => Record<string, string>;
  log?: (m: string) => void;
}

/**
 * 后台任务:把命令交给一个脱离 Agent 的 bash 去跑,输出写进日志文件,结束时把退出码写进一个文件。
 * 靠这个文件判断是否结束,所以 Agent 重启、更新都不影响正在跑的任务,重启后接着盯就行。
 */
export class JobManager {
  onDone: (job: Job) => void | Promise<void> = () => {};
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private log: (m: string) => void;

  constructor(private d: JobDeps) {
    this.log = d.log ?? console.log;
    mkdirSync(d.dir, { recursive: true });
  }

  get store(): JobStore {
    return this.d.store;
  }
  private file(id: number, ext: "log" | "exit") {
    return join(this.d.dir, `${id}.${ext}`);
  }

  start(space: string, command: string, timeoutMinutes = 120): Job {
    const timeoutS = Math.min(Math.max(Math.round(timeoutMinutes) || 120, 1), 720) * 60;
    const job = this.store.create(space, command, timeoutS);
    const args = [
      "bash",
      "-c",
      // 命令的输出进日志;结束后先写临时文件再改名,读到退出码文件就说明一定写完了
      'bash -c "$1" >"$2" 2>&1 </dev/null; echo $? >"$3.tmp"; mv "$3.tmp" "$3"',
      "_",
      command,
      this.file(job.id, "log"),
      this.file(job.id, "exit"),
    ];
    if (Bun.which("setsid")) args.unshift("setsid");
    try {
      const proc = Bun.spawn(args, {
        cwd: this.d.cwd(),
        env: { ...process.env, ...this.d.env() },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
      this.store.setPid(job.id, proc.pid);
    } catch (e) {
      this.store.finish(job.id, "error", null, `启动失败:${e}`);
    }
    this.startWatching();
    return this.store.get(job.id)!;
  }

  /** 日志末尾 */
  async tail(job: Job, chars = RESULT_CHARS): Promise<string> {
    const f = Bun.file(this.file(job.id, "log"));
    if (!(await f.exists())) return "";
    const size = f.size;
    const text = await f.slice(Math.max(0, size - chars * 4)).text();
    const clean = stripAnsi(text).replace(/\r/g, "").trim();
    return clean.length > chars ? `…\n${clean.slice(-chars)}` : clean;
  }

  async abort(id: number): Promise<boolean> {
    const job = this.store.get(id);
    if (!job || job.status !== "running") return false;
    const result = await this.tail(job);
    if (!this.store.finish(id, "aborted", null, `已中止\n${result}`.trim())) return false;
    this.kill(job.pid);
    return true;
  }

  private kill(pid: number | null) {
    if (!pid) return;
    const send = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {}
      }
    };
    send("SIGTERM");
    setTimeout(() => send("SIGKILL"), 3000).unref();
  }

  private alive(pid: number | null): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private exitCode(id: number): number | null {
    const f = this.file(id, "exit");
    if (!existsSync(f)) return null;
    const n = parseInt(readFileSync(f, "utf8").trim(), 10);
    return Number.isNaN(n) ? 1 : n;
  }

  /** 检查所有在跑的任务,结束的收尾并回调 */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const job of this.store.running()) {
        const code = this.exitCode(job.id);
        if (code !== null) {
          await this.settle(job, code === 0 ? "done" : "error", code, "");
        } else if (now() - job.created > job.timeoutS) {
          this.kill(job.pid);
          await this.settle(job, "error", null, `超过 ${Math.round(job.timeoutS / 60)} 分钟还没结束,已被终止`);
        } else if (!this.alive(job.pid)) {
          // 进程没了:再看一眼退出码文件,避免它刚好在两次检查之间写完
          const again = this.exitCode(job.id);
          if (again !== null) await this.settle(job, again === 0 ? "done" : "error", again, "");
          else await this.settle(job, "error", null, "进程意外消失了(可能被系统杀掉,或者 Agent 所在的机器重启过)");
        }
      }
    } catch (e) {
      this.log(`job poll failed: ${e}`);
    } finally {
      this.polling = false;
    }
  }

  private async settle(job: Job, status: "done" | "error", code: number | null, note: string) {
    const out = await this.tail(job);
    const result = [note, out].filter(Boolean).join("\n");
    if (!this.store.finish(job.id, status, code, result)) return;
    try {
      await this.onDone(this.store.get(job.id)!);
    } catch (e) {
      this.log(`job onDone failed: ${e}`);
    }
  }

  /** 开始定期检查(幂等)。启动时顺便清理很久以前的日志 */
  startWatching(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    void this.poll();
    this.prune();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private prune() {
    try {
      const limit = Date.now() - KEEP_LOG_DAYS * 86400_000;
      for (const f of readdirSync(this.d.dir)) {
        const p = join(this.d.dir, f);
        if (statSync(p).mtimeMs < limit) rmSync(p, { force: true });
      }
    } catch {}
  }
}
