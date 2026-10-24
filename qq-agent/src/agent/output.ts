/** 模型输出里一条消息的组成部分 */
export type OutPart =
  | { type: "text"; text: string }
  | { type: "at"; id: string }
  | { type: "reply"; id: string }
  | { type: "media"; kind: "sticker" | "image" | "video"; ref: string };

export interface OutMessage {
  parts: OutPart[];
}

const MSG_RE = /<msg>([\s\S]*?)<\/msg>/g;
const TAG_RE = /<(at|reply|sticker|image|video)\s+(?:id|ref)\s*=\s*"([^"]*)"\s*\/?>/g;

function parseParts(body: string): OutPart[] {
  const parts: OutPart[] = [];
  let last = 0;
  for (const m of body.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    pushText(parts, body.slice(last, idx));
    const [, tag, ref] = m as unknown as [string, string, string];
    if (tag === "at" || tag === "reply") parts.push({ type: tag, id: ref });
    else parts.push({ type: "media", kind: tag as "sticker" | "image" | "video", ref });
    last = idx + m[0].length;
  }
  pushText(parts, body.slice(last));
  return parts;
}

function pushText(parts: OutPart[], text: string) {
  const t = text.replace(/<\/?msg>/g, "");
  if (t.trim()) parts.push({ type: "text", text: t.trim() });
}

/**
 * 解析模型的回复。格式:
 *   <msg>第一条</msg><msg>第二条<at id="123"/></msg>
 * 没有 <msg> 标签时整段文字当作一条;<silent/> 或空内容表示不回复。
 */
export function parseOutput(raw: string): OutMessage[] {
  const text = raw.trim();
  if (!text || /<silent\s*\/?>/.test(text)) return [];
  const out: OutMessage[] = [];
  const matches = [...text.matchAll(MSG_RE)];
  if (matches.length === 0) {
    const parts = parseParts(text);
    return parts.length ? [{ parts }] : [];
  }
  for (const m of matches) {
    const parts = parseParts(m[1] ?? "");
    if (parts.length) out.push({ parts });
  }
  return out;
}

export function plainLength(msg: OutMessage): number {
  return msg.parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
}
