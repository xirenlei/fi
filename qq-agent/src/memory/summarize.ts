import type { LlmClient } from "../llm/client";
import { textOf } from "../llm/client";
import { formatLines } from "../agent/context";
import type { Db } from "./db";

const SUMMARY_SYSTEM = `你负责把聊天记录整合进已有摘要。要求:
- 保留核心信息:人物与关系、事实、偏好、约定、未完成的事、重要结论。
- 去掉寒暄和流水账,但不要丢掉会影响后续对话的细节。
- 直接输出新的完整摘要,条理清楚,不超过 800 字,不要写前言。`;

/**
 * 一个会话的近期消息涨到 maxMessages 条时,把最老的 chunk 条整合进摘要。
 * 之后近期消息保持在 maxMessages-chunk 到 maxMessages 之间,只往后追加、偶尔一次性砍掉开头,
 * 所以这个会话块的开头绝大多数时候不变,上下文能命中缓存。
 */
export async function compactSpace(db: Db, llm: LlmClient, model: string, space: string, maxMessages: number, chunk: number): Promise<boolean> {
  const msgs = db.included(space);
  if (msgs.length < maxMessages) return false;
  const old = msgs.slice(0, chunk);
  const row = db.getSpace(space);
  const user = [row.summary ? `已有摘要:\n${row.summary}` : "已有摘要:(无)", "需要整合的新聊天记录:", ...formatLines(old)].join("\n");
  const res = await llm.chat({
    model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: user },
    ],
    thinking: { enabled: false },
    maxTokens: 1500,
  });
  const summary = textOf(res.message).trim();
  if (!summary) return false;
  db.setSummaryInc(space, summary, old.at(-1)!.inc ?? 0);
  return true;
}
