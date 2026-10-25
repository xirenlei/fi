import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type Tool } from "../agent/tools";
import type { JobManager } from "../jobs/jobs";

const OUT_LIMIT = 8000;

function clip(s: string, limit = OUT_LIMIT): string {
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n…(中间省略 ${s.length - limit} 字)…\n${s.slice(-half)}`;
}

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export async function runShell(command: string, cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<ShellResult> {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, output: `${out}${err ? `\n[stderr]\n${err}` : ""}`.trim(), timedOut };
}

export interface SystemToolsOptions {
  /** 后台任务;没有时 shell 不支持 background */
  jobs?: JobManager;
  /** 每条命令都带上的环境变量 */
  env?: () => Record<string, string>;
}

/** 只给 Agent 保留少量直接动手的能力:执行命令(包括在后台启动 OpenCode)和看文件 */
export function systemTools(workdir: () => string, opts: SystemToolsOptions = {}): Tool[] {
  return [
    defineTool(
      "shell",
      "在服务器上执行一条 bash 命令:管理 OpenCode、看日志、改配置,以及在后台启动 OpenCode 干活。" +
        "几秒钟能跑完的命令直接执行;会跑很久的(尤其是 OpenCode)必须设 background=true,它会立刻返回任务号,结束时再通知你。" +
        "复杂的工作请交给 OpenCode,不要自己用它写代码。",
      {
        command: { type: "string" },
        background: { type: "boolean", description: "放到后台执行,立刻返回任务号,结束后通知你。默认 false" },
        timeout_seconds: { type: "number", description: "前台执行的超时,默认 60,最大 600" },
        timeout_minutes: { type: "number", description: "后台任务的超时,默认 120,最大 720" },
      },
      ["command"],
      async (a, ctx) => {
        const command = String(a.command ?? "");
        const env = opts.env?.() ?? {};
        if (a.background) {
          if (!opts.jobs) return "后台执行没有启用";
          const job = opts.jobs.start(ctx.space, command, Number(a.timeout_minutes) || undefined);
          return `已在后台启动,任务 #${job.id}。结束时会通知你,不用等;想看进度用 job_result。`;
        }
        const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), 600) * 1000;
        const r = await runShell(command, workdir(), timeout, env);
        const head = r.timedOut ? "[超时被终止]" : `[退出码 ${r.code}]`;
        return `${head}\n${clip(r.output)}`;
      },
    ),
    defineTool(
      "read_file",
      "读取一个文本文件的内容(最多约 8000 字)。",
      { path: { type: "string" } },
      ["path"],
      (a) => {
        const p = resolve(workdir(), String(a.path ?? ""));
        const st = statSync(p);
        if (st.isDirectory()) return "这是目录,请用 list_dir";
        if (st.size > 2_000_000) return `文件太大(${st.size} 字节)`;
        return clip(readFileSync(p, "utf8"));
      },
    ),
    defineTool(
      "list_dir",
      "列出一个目录下的文件和子目录。",
      { path: { type: "string", description: "相对工作目录或绝对路径,默认工作目录" } },
      [],
      (a) => {
        const p = resolve(workdir(), String(a.path ?? "."));
        const rows = readdirSync(p, { withFileTypes: true })
          .slice(0, 200)
          .map((d) => `${d.isDirectory() ? "d" : "-"} ${d.name}`);
        return rows.length ? rows.join("\n") : "(空目录)";
      },
    ),
  ];
}

export { join };
