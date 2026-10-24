import type { ChatMessage, LlmClient } from "../llm/client";
import { textOf } from "../llm/client";

export interface Description {
  summary: string;
  detail: string;
  tags: string[];
}

const SYSTEM = `你是图片索引员。根据给出的图片(视频或动图会给出几帧),输出 JSON:
{"summary": "不超过 16 字的摘要,说清内容或表情含义", "detail": "一到两句话的客观描述,图中有文字要抄下来", "tags": ["3 到 6 个检索用关键词"]}
只输出 JSON。表情包要点明情绪和用途(例如「无语」「开心」「嘲讽」)。`;

const FALLBACK: Description = { summary: "未识别", detail: "", tags: [] };

export function parseDescription(text: string): Description {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return FALLBACK;
  try {
    const o = JSON.parse(m[0]);
    const summary = String(o.summary ?? "").trim();
    if (!summary) return FALLBACK;
    return {
      summary: summary.slice(0, 40),
      detail: String(o.detail ?? "").trim().slice(0, 300),
      tags: Array.isArray(o.tags) ? o.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    };
  } catch {
    return FALLBACK;
  }
}

/** 单独发一个轻量请求描述图片,图片 token 不进入主对话 */
export async function describeMedia(
  llm: LlmClient,
  model: string,
  what: string,
  dataUrls: string[],
): Promise<Description> {
  if (!dataUrls.length) return FALLBACK;
  const user: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: `这是${what}。` },
      ...dataUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  };
  const res = await llm.chat({
    model,
    messages: [{ role: "system", content: SYSTEM }, user],
    thinking: { enabled: false },
    maxTokens: 400,
  });
  return parseDescription(textOf(res.message));
}
