import { adminOnly } from "../tools/system";
import { defineTool, type Tool } from "../agent/tools";
import type { OpenCodeManager } from "./manager";

const fmtTask = (t: { id: number; status: string; prompt: string; sessionId: string }) =>
  `#${t.id} [${t.status}] 会话 ${t.sessionId} — ${t.prompt.slice(0, 60)}`;

export function openCodeTools(oc: OpenCodeManager): Tool[] {
  return [
    defineTool(
      "opencode_run",
      "把一项实际工作交给 OpenCode 去做(写代码、改文件、查资料、跑命令、排查问题等),后台异步执行,完成后会自动通知你。prompt 要写清楚目标、背景和约束。仅管理员可用。",
      {
        prompt: { type: "string", description: "交给 OpenCode 的完整任务描述" },
        session_id: { type: "string", description: "可选,在已有的 OpenCode 会话里继续(追问、补充需求)" },
      },
      ["prompt"],
      adminOnly(async (a, ctx) => {
        const task = await oc.submit(ctx.space, String(a.prompt ?? ""), a.session_id ? String(a.session_id) : undefined);
        return `已交给 OpenCode,任务 #${task.id},会话 ${task.sessionId}。完成后会通知你,不用等。`;
      }),
    ),
    defineTool("opencode_status", "查看最近的 OpenCode 任务和状态", {}, [], () => {
      const rows = oc.tasks.recent(10);
      return rows.length ? rows.map(fmtTask).join("\n") : "还没有任务";
    }),
    defineTool("opencode_result", "读取某个 OpenCode 任务的完整输出", { task_id: { type: "number" } }, ["task_id"], async (a) => {
      const t = oc.tasks.get(Number(a.task_id));
      if (!t) return "没有这个任务";
      return `${fmtTask(t)}\n${await oc.fullResult(t)}`;
    }),
    defineTool(
      "opencode_abort",
      "中止一个正在运行的 OpenCode 任务。仅管理员可用。",
      { task_id: { type: "number" } },
      ["task_id"],
      adminOnly(async (a) => ((await oc.abort(Number(a.task_id))) ? "已中止" : "没有这个运行中的任务")),
    ),
  ];
}

export function openCodePromptSection(workdir: string): string {
  return [
    "# 工作交给 OpenCode",
    "你自己只负责聊天和轻量操作。真正的工作(写代码、改文件、查资料、搭环境、排查问题、跑长任务)都交给 OpenCode:用 opencode_run 提交任务,它在后台干,干完会有一条「系统」消息通知你,到时你再用自然的口吻向用户汇报结果,重点说结论,不要照搬原文。",
    `OpenCode 的工作目录是 ${workdir}。`,
    "- 提交任务后先简短告诉用户「交给 OpenCode 了」,然后不要干等。",
    "- 想让 OpenCode 接着上次的活继续,就带上 session_id。",
    "- 需要管理 OpenCode 本身(重启、看日志、改配置)时用 shell 工具;只有管理员能让你执行这些操作,其他人提出这类要求时礼貌拒绝。",
    "- 不要执行会破坏系统或泄露密钥的命令,也不要把配置文件里的密钥发到聊天里。",
  ].join("\n");
}
