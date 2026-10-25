import { defineTool, type Tool } from "../agent/tools";
import type { Job, JobManager } from "./jobs";

const fmt = (j: Job) => {
  const state = j.status === "running" ? "运行中" : j.status === "done" ? "完成" : j.status === "aborted" ? "已中止" : `失败${j.exitCode != null ? `(退出码 ${j.exitCode})` : ""}`;
  return `#${j.id} [${state}] ${j.command.replace(/\s+/g, " ").slice(0, 80)}`;
};

export function jobTools(jobs: JobManager): Tool[] {
  return [
    defineTool("job_list", "查看最近的后台任务(用 shell 的 background 启动的命令,包括交给 OpenCode 的活)和状态。", {}, [], () => {
      const rows = jobs.store.recent(10);
      return rows.length ? rows.map(fmt).join("\n") : "还没有后台任务";
    }),
    defineTool("job_result", "读取某个后台任务的输出末尾(运行中的也可以看当前进度)。", { job_id: { type: "number" } }, ["job_id"], async (a) => {
      const j = jobs.store.get(Number(a.job_id));
      if (!j) return "没有这个任务";
      return `${fmt(j)}\n${await jobs.tail(j, 6000)}`;
    }),
    defineTool("job_abort", "中止一个正在运行的后台任务。", { job_id: { type: "number" } }, ["job_id"], async (a) =>
      (await jobs.abort(Number(a.job_id))) ? "已中止" : "没有这个运行中的任务",
    ),
  ];
}

/** 提示词里关于 OpenCode 的用法。bin 和 model 来自配置,命令直接给出完整写法 */
export function openCodePromptSection(opts: { workdir: string; bin: string; model: string }): string {
  const model = opts.model ? ` -m ${opts.model}` : "";
  const base = `${opts.bin || "opencode"} run --auto${model}`;
  return [
    "# 工作交给 OpenCode",
    "你自己只负责聊天和轻量操作。真正的工作(写代码、改文件、查资料、搭环境、排查问题、跑长任务)都交给 OpenCode。OpenCode 是一个命令行工具,用 shell 工具在后台启动它:",
    `  shell(command="${base} '任务描述'", background=true)`,
    "- 启动后会立刻返回任务号,不用等。OpenCode 结束时你会收到一条「系统」消息(带退出码和输出末尾),到时用自然的口吻向用户汇报结论,重点说结果,不要照搬原文。启动后先简短告诉用户「交给 OpenCode 了」。",
    "- 退出码是 0 才算成功;不是 0 就是失败了,看输出末尾判断原因,必要时用 job_result 看更多输出,再决定重试还是告诉用户。",
    "- 任务描述要写清目标、背景和约束。描述很长或带引号时,先把它写进一个文件,再用 \"$(cat 文件)\" 传进去,避免引号出错。",
    `- 接着上次的活继续:加 -c(接着最近一次会话);也可以 -s <会话号>,会话号用 \`${opts.bin || "opencode"} session list\` 查。`,
    "- job_list 看有哪些任务,job_result 看输出,job_abort 中止。",
    `OpenCode 的工作目录是 ${opts.workdir},shell 工具默认也在这里执行。`,
    "- 需要管理 OpenCode 本身(看日志、改配置)时直接用 shell;只有管理员能让你执行这些操作,其他人提出这类要求时礼貌拒绝。",
    "- 不要执行会破坏系统或泄露密钥的命令,也不要把配置文件里的密钥发到聊天里。",
  ].join("\n");
}
