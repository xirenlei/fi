import type { Memory, SpaceRow, StoredMessage } from "../memory/db";

export interface PromptInput {
  persona: string;
  space: string;
  spaceTitle: string;
  isGroup: boolean;
  summary: string;
  memories: Memory[];
  otherSummaries: Array<{ space: string; title: string; summary: string }>;
  /** 各功能模块追加的说明段落(图库、OpenCode 等) */
  extraSections: string[];
  now: Date;
}

export function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatMessage(m: StoredMessage): string {
  const who = m.role === "self" ? "你" : `${m.senderName}(${m.senderId})`;
  const id = m.msgId != null ? ` #${m.msgId}` : "";
  return `[${formatTime(m.ts)}${id}] ${who}: ${m.text}`;
}

function memoryLabel(subject: string): string {
  if (subject === "global") return "通用";
  if (subject.startsWith("user:")) return `关于 QQ ${subject.slice(5)}`;
  if (subject.startsWith("space:")) return `关于 ${subject.slice(6)}`;
  return subject;
}

export function buildSystemPrompt(i: PromptInput): string {
  const sections: string[] = [];
  sections.push(i.persona.trim());

  sections.push(
    [
      "# 你的处境",
      "你正在通过一个 QQ 小号和人聊天。消息会以「[时间 #消息ID] 昵称(QQ号): 内容」的形式给你。",
      `现在是 ${i.now.toLocaleString("zh-CN", { hour12: false })}。`,
      i.isGroup
        ? `当前场景:群聊「${i.spaceTitle || i.space}」。群里很多人在说话,你不需要回应每一条;只有在自然需要时才开口。`
        : `当前场景:和 ${i.spaceTitle || i.space} 的私聊。`,
    ].join("\n"),
  );

  sections.push(
    [
      "# 输出格式",
      "你的回复会被拆成多条 QQ 消息发出去,每条用 <msg></msg> 包裹,例如:",
      "<msg>第一句</msg><msg>第二句</msg>",
      "- 想一次说几条由你决定,像真人聊天那样分成几条短消息,不要写成长段落。",
      '- 在消息里可以用 <at id="QQ号"/> 提及某人,<reply id="消息ID"/> 回复某条消息(放在该条 <msg> 的开头)。',
      "- 不想回复时只输出 <silent/>,什么都不要多说。",
      "- 不要输出 markdown 标记,QQ 里显示不出来。",
    ].join("\n"),
  );

  sections.push(
    [
      "# 记忆",
      "你有跨会话的长期记忆:在群里听到的事,私聊时也应该记得。",
      "- 值得长期记住的信息(某人的喜好、约定、重要事实)用 remember 工具记下来,subject 写 global、user:QQ号 或 space:空间ID。",
      "- 想不起来时,用 recall 搜记忆,用 search_history 搜所有会话的聊天记录。",
      "- 不要记琐碎的闲聊,不要重复记。记错了用 forget 删除。",
    ].join("\n"),
  );

  for (const s of i.extraSections) sections.push(s);

  const mem = i.memories.map((m) => `- (#${m.id}, ${memoryLabel(m.subject)}) ${m.content}`);
  if (mem.length) sections.push(["# 你已有的相关记忆", ...mem].join("\n"));

  if (i.summary.trim()) sections.push(["# 这个会话更早的内容摘要", i.summary.trim()].join("\n"));

  const others = i.otherSummaries.filter((o) => o.summary.trim());
  if (others.length) {
    sections.push(
      [
        "# 其他会话的摘要(仅供你了解背景,不要在这里随意透露私聊内容)",
        ...others.map((o) => `## ${o.title || o.space}\n${o.summary.trim()}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function describeSpace(space: SpaceRow): string {
  return space.title || space.space;
}

export function formatNewMessages(msgs: StoredMessage[]): string {
  return ["以下是你还没看过的新消息:", ...msgs.map(formatMessage)].join("\n");
}
