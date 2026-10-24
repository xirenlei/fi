import type { LlmClient } from "../llm/client";
import { textOf } from "../llm/client";
import type { Db } from "./db";
import { formatMessage } from "../agent/prompt";

const SUMMARY_SYSTEM = `你负责把聊天记录整合进已有摘要。要求:
- 保留核心信息:人物与关系、事实、偏好、约定、未完成的事、重要结论。
- 去掉寒暄和流水账,但不要丢掉会影响后续对话的细节。
- 直接输出新的完整摘要,条理清楚,不超过 800 字,不要写前言。`;

/** 超出窗口(windowSize + slack)的旧消息整合进摘要,并清掉对应的对话轮次 */
export async function maybeSummarize(
  db: Db,
  llm: LlmClient,
  model: string,
  space: string,
  windowSize: number,
  slack = 50,
): Promise<boolean> {
  const row = db.getSpace(space);
  const cutoff = db.nthRecentId(space, windowSize);
  if (cutoff <= row.summarizedUpto) return false;
  const old = db.messagesBetween(space, row.summarizedUpto, cutoff);
  if (old.length < slack) return false;

  const user = [
    row.summary ? `已有摘要:\n${row.summary}` : "已有摘要:(无)",
    "需要整合的新聊天记录:",
    ...old.map(formatMessage),
  ].join("\n");
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
  db.setSummary(space, summary, cutoff);
  db.deleteTurnsUpto(space, cutoff);
  return true;
}
