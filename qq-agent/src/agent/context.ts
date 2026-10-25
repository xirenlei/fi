import type { Memory, StoredMessage } from "../memory/db";

/**
 * 把「所有会话的记忆」拼成一段上下文。顺序是:越稳定的越靠前,每次都变的放最后:
 *
 *   长期记忆 → 各会话摘要 → 各会话近期聊天(最久没动静的在前,正在处理的在最后)
 *   → 其他会话还没处理的新消息 → 现在(时间、要处理的新消息)
 *
 * 这样连续处理同一个会话时,前面一大段和上次请求逐字相同,能命中模型接口的前缀缓存。
 * 要点:每个会话块只在末尾追加,不会因为窗口滑动而改变开头。
 */

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mmdd = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function spaceLabel(space: string, title: string): string {
  const name = title && title !== space ? `「${title}」` : "";
  return `${space.startsWith("g:") ? "群" : "私聊"}${name} ${space}`;
}

export function memoryLabel(subject: string): string {
  if (subject === "global") return "通用";
  if (subject.startsWith("user:")) return `关于 QQ ${subject.slice(5)}`;
  if (subject.startsWith("space:")) return `关于会话 ${subject.slice(6)}`;
  return subject;
}

export interface LineOptions {
  selfId?: number;
  /** 给每条消息带上 #消息ID(只有"新消息"需要,引用回复和贴表情要用) */
  withIds?: boolean;
}

/** 一批消息排成紧凑的几行:`11:03 小明: 在吗`。每个人第一次出现时带上 QQ 号,重名的每次都带 */
export function formatLines(messages: StoredMessage[], opts: LineOptions = {}): string[] {
  const namesToIds = new Map<string, Set<number>>();
  for (const m of messages) {
    if (m.role === "self") continue;
    const set = namesToIds.get(m.senderName) ?? new Set<number>();
    set.add(m.senderId);
    namesToIds.set(m.senderName, set);
  }
  const introduced = new Set<number>();
  const lines: string[] = [];
  let day = "";
  for (const m of messages) {
    const d = mmdd(m.ts);
    if (d !== day) {
      day = d;
      lines.push(`── ${d} ──`);
    }
    let who: string;
    if (m.role === "self") who = "我";
    else if (m.senderId === 0) who = m.senderName || "系统";
    else {
      const ambiguous = (namesToIds.get(m.senderName)?.size ?? 0) > 1;
      const tag = ambiguous || !introduced.has(m.senderId);
      introduced.add(m.senderId);
      who = tag ? `${m.senderName}(${m.senderId})` : m.senderName;
    }
    let text = m.text.replace(/\r?\n/g, " ⏎ ");
    if (opts.selfId !== undefined) text = text.replace(/@(\d+)/g, (all, id) => (Number(id) === opts.selfId ? "@我" : all));
    const id = opts.withIds && m.msgId != null ? ` #${m.msgId}` : "";
    lines.push(`${hhmm(m.ts)}${id} ${who}: ${text}`);
  }
  return lines;
}

export interface SpaceBlock {
  space: string;
  title: string;
  messages: StoredMessage[];
}

export interface ContextInput {
  now: Date;
  selfId?: number;
  memories: Memory[];
  /** 各会话的摘要,调用方按固定顺序(会话号)给 */
  summaries: Array<{ space: string; title: string; summary: string }>;
  /** 各会话的近期聊天,调用方按「最久没动静在前,正在处理的在最后」排好 */
  blocks: SpaceBlock[];
  /** 其他会话里还没处理的新消息 */
  others: SpaceBlock[];
  /** 正在处理的会话和它的新消息 */
  active?: { space: string; title: string; pending: StoredMessage[]; hidden: number };
  /** 没有正在处理的会话时(自由时间、事件唤醒),这里写要它做什么 */
  free?: string;
  /** 上下文总字数的保险丝,超了就从最冷的会话块开始只留最近几十行 */
  maxChars?: number;
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const TRUNCATED_KEEP = 40;

function renderBlock(b: SpaceBlock, selfId: number | undefined, keepLast?: number): string {
  let lines = formatLines(b.messages, { selfId });
  let note = "";
  if (keepLast !== undefined && lines.length > keepLast) {
    lines = lines.slice(-keepLast);
    note = "(更早的内容因太长已省略)\n";
  }
  return `【${spaceLabel(b.space, b.title)}】\n${note}${lines.join("\n")}`;
}

export function renderContext(i: ContextInput): string {
  const parts: string[] = [];

  if (i.memories.length) {
    parts.push(["## 长期记忆", ...i.memories.map((m) => `- #${m.id} [${memoryLabel(m.subject)}] ${m.content}`)].join("\n"));
  }
  const sums = i.summaries.filter((s) => s.summary.trim());
  if (sums.length) {
    parts.push(["## 各会话更早的内容摘要", ...sums.map((s) => `【${spaceLabel(s.space, s.title)}】\n${s.summary.trim()}`)].join("\n"));
  }

  let blocks = i.blocks.map((b) => renderBlock(b, i.selfId));
  const total = () => blocks.reduce((n, b) => n + b.length, 0);
  // 保险丝:太长时从最冷的块开始截短(确定性的,同样的输入得到同样的结果)
  for (let k = 0; i.maxChars !== undefined && total() > i.maxChars && k < i.blocks.length; k++) {
    blocks[k] = renderBlock(i.blocks[k]!, i.selfId, TRUNCATED_KEEP);
  }
  if (blocks.length) parts.push(["## 各会话最近的聊天", ...blocks].join("\n\n"));

  const others = i.others.filter((o) => o.messages.length);
  if (others.length) {
    parts.push(
      [
        "## 其他会话里还没处理的新消息(你现在不用回复它们,轮到时再处理)",
        ...others.map((o) => `【${spaceLabel(o.space, o.title)}】\n${formatLines(o.messages, { selfId: i.selfId }).join("\n")}`),
      ].join("\n\n"),
    );
  }

  const now = i.now;
  const clock = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} 星期${WEEKDAY[now.getDay()]}`;
  const tail = [`## 现在`, `现在是 ${clock}。`];
  if (i.active) {
    tail.push(`现在要处理的是 ${spaceLabel(i.active.space, i.active.title)} 的新消息,你的回复会发到这个会话。`);
    if (i.active.hidden > 0) tail.push(`(更早还有 ${i.active.hidden} 条新消息没有显示,它们稍后会出现在这个会话的聊天记录里)`);
    tail.push("新消息:", ...formatLines(i.active.pending, { selfId: i.selfId, withIds: true }));
  } else if (i.free) {
    tail.push(i.free);
  }
  parts.push(tail.join("\n"));

  return parts.join("\n\n");
}
