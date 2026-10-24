import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type Tool, type ToolContext } from "../agent/tools";

const DENIED = "没有权限:只有管理员可以让我做这件事。";
const OUT_LIMIT = 8000;

function clip(s: string, limit = OUT_LIMIT): string {
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n…(中间省略 ${s.length - limit} 字)…\n${s.slice(-half)}`;
}

export function adminOnly(run: Tool["run"]): Tool["run"] {
  return (args, ctx: ToolContext) => (ctx.isAdmin ? run(args, ctx) : DENIED);
}

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export async function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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

/** 只给 Agent 保留少量直接动手的能力:执行命令(用来管理 OpenCode)和看文件 */
export function systemTools(workdir: () => string): Tool[] {
  return [
    defineTool(
      "shell",
      "在服务器上执行一条 bash 命令,主要用来管理 OpenCode(启停、看日志、改配置)。复杂的工作请交给 OpenCode,不要自己用它写代码。仅管理员可用。",
      {
        command: { type: "string" },
        timeout_seconds: { type: "number", description: "默认 60,最大 600" },
      },
      ["command"],
      adminOnly(async (a) => {
        const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), 600) * 1000;
        const r = await runShell(String(a.command ?? ""), workdir(), timeout);
        const head = r.timedOut ? "[超时被终止]" : `[退出码 ${r.code}]`;
        return `${head}\n${clip(r.output)}`;
      }),
    ),
    defineTool(
      "read_file",
      "读取一个文本文件的内容(最多约 8000 字)。仅管理员可用。",
      { path: { type: "string" } },
      ["path"],
      adminOnly((a) => {
        const p = resolve(workdir(), String(a.path ?? ""));
        const st = statSync(p);
        if (st.isDirectory()) return "这是目录,请用 list_dir";
        if (st.size > 2_000_000) return `文件太大(${st.size} 字节)`;
        return clip(readFileSync(p, "utf8"));
      }),
    ),
    defineTool(
      "list_dir",
      "列出一个目录下的文件和子目录。仅管理员可用。",
      { path: { type: "string", description: "相对工作目录或绝对路径,默认工作目录" } },
      [],
      adminOnly((a) => {
        const p = resolve(workdir(), String(a.path ?? "."));
        const rows = readdirSync(p, { withFileTypes: true })
          .slice(0, 200)
          .map((d) => `${d.isDirectory() ? "d" : "-"} ${d.name}`);
        return rows.length ? rows.join("\n") : "(空目录)";
      }),
    ),
  ];
}

export { join };
