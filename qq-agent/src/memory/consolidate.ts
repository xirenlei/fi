import type { LlmClient } from "../llm/client";
import { textOf } from "../llm/client";
import type { Db } from "./db";

const SYSTEM = `你负责整理一个人的长期记忆笔记。输入是很多条「标签 | 内容」。要求:
- 合并重复和相近的条目,去掉过时的、琐碎的,保留重要的事实、偏好、约定、关系。
- 标签必须原样沿用,只能是 global、user:数字、space:g:数字、space:p:数字 这几种;同一个人或同一个会话的内容可以合成一条。
- 总字数压缩到原来的 60% 以内,但不要丢掉重要信息。
- 只输出一个 JSON 数组,每个元素是 {"subject": "...", "content": "..."},不要任何别的文字。`;

const SUBJECT_RE = /^(global|user:\d+|space:[gp]:\d+)$/;

export function parseConsolidation(text: string): Array<{ subject: string; content: string }> | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const out = arr
      .map((e) => ({ subject: String(e?.subject ?? "").trim(), content: String(e?.content ?? "").trim() }))
      .filter((e) => SUBJECT_RE.test(e.subject) && e.content);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** 长期记忆超过上限时让模型整理合并;旧条目整批归档,不会真的丢。返回是否做了整理 */
export async function consolidateMemories(db: Db, llm: LlmClient, model: string, maxChars: number): Promise<boolean> {
  const before = db.memoryChars();
  if (before <= maxChars) return false;
  const all = db.allMemories();
  const res = await llm.chat({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: all.map((m) => `${m.subject} | ${m.content}`).join("\n") },
    ],
    thinking: { enabled: false },
    maxTokens: 4000,
  });
  const entries = parseConsolidation(textOf(res.message));
  if (!entries) return false;
  const after = entries.reduce((n, e) => n + e.subject.length + e.content.length + 12, 0);
  if (after >= before) return false; // 没压缩就不换,免得白白打乱上下文
  db.replaceMemories(entries);
  return true;
}
