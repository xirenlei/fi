import type { Db } from "../memory/db";
import { formatMessage } from "./prompt";
import type { ToolDef } from "../llm/client";

/** 一次工具调用的上下文 */
export interface ToolContext {
  space: string;
  /** 触发本轮的消息的发送者 */
  triggerSenderIds: number[];
  isAdmin: boolean;
}

export interface Tool {
  def: ToolDef;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export function defineTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: Tool["run"],
): Tool {
  return {
    def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
    run,
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function memoryTools(db: Db): Tool[] {
  return [
    defineTool(
      "remember",
      "把一条值得长期记住的信息存入长期记忆",
      {
        subject: { type: "string", description: "global、user:QQ号 或 space:空间ID(如 g:123、p:456)" },
        content: { type: "string", description: "要记住的内容,写成完整、独立的一句话" },
      },
      ["subject", "content"],
      (args) => {
        const subject = str(args.subject).trim();
        const content = str(args.content).trim();
        if (!content) return "content 不能为空";
        if (!/^(global|user:\d+|space:[gp]:\d+)$/.test(subject)) return "subject 格式不对,应为 global、user:QQ号 或 space:g:群号 / space:p:QQ号";
        const id = db.addMemory(subject, content);
        return `已记住,编号 ${id}`;
      },
    ),
    defineTool("forget", "删除一条记忆", { id: { type: "number", description: "记忆编号" } }, ["id"], (args) =>
      db.deleteMemory(Number(args.id)) ? "已删除" : "没有这条记忆",
    ),
    defineTool("recall", "按关键词搜索长期记忆", { query: { type: "string" } }, ["query"], (args) => {
      const rows = db.searchMemories(str(args.query));
      if (!rows.length) return "没有找到相关记忆";
      return rows.map((m) => `#${m.id} [${m.subject}] ${m.content}`).join("\n");
    }),
    defineTool(
      "search_history",
      "按关键词搜索所有会话(群聊和私聊)里的历史聊天记录",
      {
        query: { type: "string" },
        space: { type: "string", description: "可选,只搜某个空间,如 g:123" },
      },
      ["query"],
      (args) => {
        const rows = db.searchMessages(str(args.query), { space: str(args.space) || undefined, limit: 20 });
        if (!rows.length) return "没有找到相关聊天记录";
        return rows.map((m) => `(${m.space}) ${formatMessage(m)}`).join("\n");
      },
    ),
  ];
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(t: Tool) {
    this.tools.set(t.def.function.name, t);
  }

  get defs(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  async run(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `未知工具:${name}`;
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return "工具参数不是合法的 JSON";
    }
    try {
      return await tool.run(args, ctx);
    } catch (e) {
      return `工具执行出错:${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
