import { defineTool, type Tool } from "../agent/tools";
import type { Db } from "../memory/db";
import { formatTime } from "../agent/prompt";

export interface ChatDeps {
  db: Db;
  /** 向某个会话发消息,raw 支持 <msg> 标签格式 */
  say(space: string, raw: string): Promise<number>;
}

/** 让 Agent 能主动找人说话(不只是被动回复) */
export function chatTools(d: ChatDeps): Tool[] {
  return [
    defineTool(
      "list_chats",
      "列出你所有的聊天(群和私聊)以及各自最近的动静,决定要不要主动找谁说话时用",
      {},
      [],
      () => {
        const rows = d.db.listSpaces().map((space) => {
          const row = d.db.getSpace(space);
          const last = d.db.recent(space, 1)[0];
          const tail = last ? `最后一条 ${formatTime(last.ts)} ${last.role === "self" ? "你" : last.senderName}: ${last.text.slice(0, 40)}` : "还没有消息";
          return `${space} 「${row.title || space}」 共 ${d.db.count(space)} 条;${tail}`;
        });
        return rows.length ? rows.join("\n") : "还没有任何聊天";
      },
    ),
    defineTool(
      "send_message",
      "主动给某个群或某个人发消息(不是回复谁,而是你自己想说)。要有理由,别打扰别人,别刷屏。",
      {
        space: { type: "string", description: "g:群号 或 p:QQ号;可以从 list_chats 里找" },
        text: { type: "string", description: "要发的内容,格式和平时回复一样,可以用 <msg> 拆成多条、带 <sticker id=\"..\"/> 等" },
      },
      ["space", "text"],
      async (a) => {
        const space = String(a.space ?? "").trim();
        if (!/^[gp]:\d+$/.test(space)) return "space 格式不对,应为 g:群号 或 p:QQ号";
        const n = await d.say(space, String(a.text ?? ""));
        return n ? `已发送 ${n} 条` : "没有发出任何内容(内容为空?)";
      },
    ),
  ];
}
