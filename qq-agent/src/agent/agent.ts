import type { Config } from "../config";
import { LlmClient, LlmError, stripAllReasoning, textOf, type ChatMessage } from "../llm/client";
import type { Db, StoredMessage } from "../memory/db";
import { consolidateMemories } from "../memory/consolidate";
import { compactSpace } from "../memory/summarize";
import { isMessageEvent } from "../napcat/client";
import { displayName, parseMessage, seg, type ParsedMessage } from "../napcat/parse";
import { parseSpace, spaceOf, type OneBotEvent, type Segment, type SpaceId } from "../napcat/types";
import { estimateTokens, formatLines, renderContext, type ContextInput, type SpaceBlock } from "./context";
import { interpretEvent, requestGuidance } from "./events";
import { judgeReply } from "./judge";
import { parseOutput, plainLength, type OutMessage, type OutPart } from "./output";
import { buildSystemPrompt } from "./prompt";
import type { ToolContext, ToolRegistry } from "./tools";

export interface NapcatLike {
  selfId?: number;
  send(space: SpaceId, message: Segment[]): Promise<number>;
  call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
}

/** 媒体处理钩子:收到图片时生成描述,发送时把标签解析成消息段 */
export interface MediaHandler {
  /** 把消息里的媒体转成文字描述;images 是只在本轮注入模型的图片 data URL */
  ingest(parsed: ParsedMessage, space: string): Promise<{ text: string; images: string[] }>;
  resolveOut(part: Extract<OutPart, { type: "media" }>, space: string): Promise<{ segment: Segment; label: string } | null>;
  promptSection?(): string;
}

export interface AgentDeps {
  cfg: () => Config;
  db: Db;
  napcat: NapcatLike;
  llm: LlmClient;
  tools: ToolRegistry;
  media?: MediaHandler;
  /** 其他模块追加到系统提示词的段落 */
  extraSections?: () => string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

type Job =
  | { kind: "space"; space: string; mentioned: boolean; forced: boolean }
  | { kind: "wander"; event?: string; resolve: (text: string) => void };

const MAX_TOOL_ROUNDS = 8;
/** 一次最多把这么多条新消息放进「现在」,更多的稍后会出现在聊天记录里 */
const MAX_PENDING = 60;
/** 其他会话积压的新消息到这个数,就并进它们自己的会话块(会让缓存失效一次,所以不能太频繁) */
const MERGE_UNSEEN_AT = 50;
/** 上下文总字数的保险丝 */
const MAX_CONTEXT_CHARS = 150_000;

const FREE_TIME_TEXT = [
  "这是你的自由时间,现在没有人在跟你说话。",
  "可以做的事(不是任务清单,看心情,也可以什么都不做,那就只输出 <silent/>):发一条动态、改签名/状态/头像、主动找某个人或某个群说句话、整理图库、跟进之前记下的事、看看 OpenCode 任务进展。",
  "先用 recall 看看自己最近做过什么,别重复。",
].join("\n");

export interface ContextSnapshot {
  tokens: { tools: number; system: number; memories: number; summaries: number; blocks: number; others: number; total: number };
  system: string;
  toolsChars: number;
  memories: { items: Array<{ id: number; subject: string; content: string; ts: number }>; chars: number; limit: number };
  summaries: Array<{ space: string; title: string; summary: string }>;
  blocks: Array<{ space: string; title: string; count: number; max: number; compactEvery: number; lines: string[]; tokens: number }>;
  others: Array<{ space: string; title: string; shown: number; unseen: number; mergeAt: number; lines: string[] }>;
  busy: boolean;
  queued: number;
  preview: string;
}

export class Agent {
  /** 全局排队:一次只处理一件事,处理完才轮到下一件,先来后到,没有任何特权 */
  private queue: Job[] = [];
  private pumping: Promise<void> | null = null;
  private busy = false;
  private lastSpoke = new Map<string, number>();
  private pendingImages = new Map<string, string[]>();
  /** 接口不接受回传思考内容时置位,之后调用都不再带 */
  private noReasoning = false;
  private lastConsolidateFail = 0;

  constructor(private d: AgentDeps) {}

  private log(m: string) {
    (this.d.log ?? console.log)(`[agent] ${m}`);
  }

  private nowSec(): number {
    return Math.floor((this.d.now?.() ?? Date.now()) / 1000);
  }

  /** 等排队的事情都处理完(测试用) */
  async idle(): Promise<void> {
    while (this.pumping || this.queue.length) await (this.pumping ?? Promise.resolve());
  }

  // ───────────── 收事件 ─────────────

  async handleEvent(ev: OneBotEvent): Promise<void> {
    if (!isMessageEvent(ev)) return this.handleOtherEvent(ev);
    const selfId = this.d.napcat.selfId ?? ev.self_id;
    const space = spaceOf(ev);
    const parsed = parseMessage({ message: ev.message, self_id: selfId });
    const isSelf = ev.post_type === "message_sent" || ev.user_id === selfId;

    let text = parsed.text;
    if (!isSelf && this.d.media && parsed.media.length) {
      try {
        const r = await this.d.media.ingest(parsed, space);
        text = r.text;
        if (r.images.length) this.pendingImages.set(space, [...(this.pendingImages.get(space) ?? []), ...r.images]);
      } catch (e) {
        this.log(`media ingest failed: ${e}`);
      }
    }

    this.d.db.addMessage({
      space,
      msgId: ev.message_id,
      ts: ev.time,
      senderId: ev.user_id,
      senderName: isSelf ? "我" : displayName(ev),
      role: isSelf ? "self" : "user",
      text,
    });
    if (isSelf) return;

    await this.ensureTitle(space, ev.sender?.nickname || displayName(ev));

    let mentioned = parsed.mentionsSelf;
    if (!mentioned && parsed.replyToId != null) {
      mentioned = this.d.db.findByMsgId(space, parsed.replyToId)?.role === "self";
    }
    this.enqueueSpace(space, mentioned, false);
  }

  /** 好友请求、入群邀请、被戳、有人进退群等非聊天事件 */
  private async handleOtherEvent(ev: OneBotEvent): Promise<void> {
    const cfg = this.d.cfg();
    const act = interpretEvent(ev, this.d.napcat.selfId ?? ev.self_id, cfg.admins);
    if (!act) return;
    if (act.type === "request") {
      if (cfg.requests.mode === "reject") {
        const r = act.reject();
        await this.d.napcat.call(r.action, r.params).catch((e) => this.log(`reject request failed: ${e}`));
        return;
      }
      void this.wander(`${act.text}\n${requestGuidance(cfg.requests.mode, act.fromAdmin)}`).catch((e) => this.log(`wander failed: ${e}`));
    } else if (act.type === "wander") {
      void this.wander(act.text).catch((e) => this.log(`wander failed: ${e}`));
    } else {
      this.d.db.addMessage({ space: act.space, msgId: null, ts: this.nowSec(), senderId: act.senderId, senderName: "系统", role: "user", text: act.text });
      if (act.trigger !== "none") this.enqueueSpace(act.space, act.trigger === "mention", false);
    }
  }

  /** 系统事件(例如 OpenCode 任务完成):写入一条系统消息并让模型处理,由模型决定怎么向用户汇报 */
  notify(space: string, text: string): void {
    this.d.db.addMessage({ space, msgId: null, ts: this.nowSec(), senderId: 0, senderName: "系统", role: "user", text });
    this.enqueueSpace(space, true, true);
  }

  private async ensureTitle(space: string, fallback: string) {
    const row = this.d.db.getSpace(space);
    if (row.title) return;
    const { type, id } = parseSpace(space);
    let title = fallback;
    if (type === "group") {
      try {
        const info = await this.d.napcat.call<{ group_name?: string }>("get_group_info", { group_id: id });
        if (info?.group_name) title = info.group_name;
      } catch {
        title = `群${id}`;
      }
    }
    this.d.db.setTitle(space, title);
  }

  // ───────────── 排队 ─────────────

  /** 同一个会话已经在排队时,新消息并进那一项(它们会一起处理),不重复排 */
  private enqueueSpace(space: string, mentioned: boolean, forced: boolean) {
    const waiting = this.queue.find((j): j is Extract<Job, { kind: "space" }> => j.kind === "space" && j.space === space);
    if (waiting) {
      waiting.mentioned ||= mentioned;
      waiting.forced ||= forced;
    } else {
      this.queue.push({ kind: "space", space, mentioned, forced });
    }
    this.pump();
  }

  /**
   * 自由时间。event 不为空表示被某件事唤醒(好友请求、OpenCode 任务完成等),要排队,不会丢;
   * 没有 event 的是定时唤醒,现在不空闲就直接放弃。返回模型最后说的话(通常是它做了什么的小结)。
   */
  wander(event?: string): Promise<string> {
    if (!event && (this.busy || this.queue.length)) return Promise.resolve("");
    return new Promise((resolve) => {
      this.queue.push({ kind: "wander", event, resolve });
      this.pump();
    });
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = this.runQueue().finally(() => {
      this.pumping = null;
      if (this.queue.length) this.pump();
    });
  }

  private async runQueue() {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      this.busy = true;
      try {
        if (job.kind === "space") {
          if (job.forced || (await this.shouldReply(job.space, job.mentioned))) await this.respond(job.space);
        } else {
          job.resolve(await this.doWander(job.event));
        }
      } catch (e) {
        this.log(`job failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
        if (job.kind === "wander") job.resolve("");
      } finally {
        this.busy = false;
      }
      await this.maintain().catch((e) => this.log(`maintenance failed: ${e}`));
    }
  }

  private async shouldReply(space: string, mentioned: boolean): Promise<boolean> {
    const cfg = this.d.cfg();
    if (parseSpace(space).type === "private") return true;
    if (mentioned && cfg.group.alwaysReplyWhenMentioned) return true;
    const last = this.lastSpoke.get(space);
    const since = last == null ? null : this.nowSec() - last;
    if (since != null && since < cfg.group.cooldownSeconds) return false;
    return judgeReply(this.d.llm, cfg.llm.lightModel, {
      persona: cfg.persona,
      context: this.d.db.recent(space, cfg.group.judgeContext),
      sinceLastSpokeSec: since,
    });
  }

  // ───────────── 拼上下文、调用模型 ─────────────

  private systemPrompt(): string {
    return buildSystemPrompt({
      persona: this.d.cfg().persona,
      admins: this.d.cfg().admins,
      extraSections: [...(this.d.extraSections?.() ?? []), ...(this.d.media?.promptSection ? [this.d.media.promptSection()] : [])],
    });
  }

  /** 拼出「所有会话」的上下文文本。active 是正在处理的会话,没有则是自由时间 */
  buildContext(opts: { active?: { space: string; pending: StoredMessage[]; hidden: number }; free?: string }): string {
    return renderContext(this.gatherContext(opts, true));
  }

  /**
   * 收集拼上下文需要的全部数据。commit 为真时会把其他会话积压够多的新消息并进它们自己的块(真正的请求用);
   * 为假时只读,不改任何东西(控制台查看用)。
   */
  private gatherContext(opts: { active?: { space: string; pending: StoredMessage[]; hidden: number }; free?: string }, commit: boolean): ContextInput {
    const db = this.d.db;
    const cfg = this.d.cfg();
    const activeSpace = opts.active?.space;

    // 其他会话积压太多的新消息,并进它们自己的块(这会让缓存失效一次,所以要攒到一定数量)
    if (commit) {
      for (const sp of db.listSpaces()) {
        if (sp !== activeSpace && db.unseenCount(sp) >= MERGE_UNSEEN_AT) db.markIncluded(db.unseen(sp).map((m) => m.id));
      }
    }

    const rows = db.contextSpaces();
    const blocks: Array<SpaceBlock & { last: number }> = [];
    for (const r of rows) {
      const messages = db.included(r.space);
      if (messages.length) blocks.push({ space: r.space, title: r.title, messages, last: db.lastInc(r.space) });
    }
    // 最久没动静的在前,正在处理的放最后:切换会话时只有后面的块失效
    blocks.sort((a, b) => (a.space === activeSpace ? 1 : b.space === activeSpace ? -1 : a.last - b.last));

    const others: SpaceBlock[] = [];
    for (const sp of db.listSpaces()) {
      if (sp === activeSpace) continue;
      const messages = db.unseen(sp, MERGE_UNSEEN_AT);
      if (messages.length) others.push({ space: sp, title: db.getSpace(sp).title, messages });
    }

    return {
      now: new Date(this.d.now?.() ?? Date.now()),
      selfId: this.d.napcat.selfId,
      memories: db.allMemories(),
      summaries: rows.filter((r) => r.summary).map((r) => ({ space: r.space, title: r.title, summary: r.summary })),
      blocks,
      others,
      active: opts.active ? { ...opts.active, title: db.getSpace(opts.active.space).title } : undefined,
      free: opts.free,
      maxChars: MAX_CONTEXT_CHARS,
    };
  }

  /** 控制台「上下文」页用:此刻发给模型的上下文由哪些部分组成,每部分多大。只读,不会改任何数据 */
  snapshot(): ContextSnapshot {
    const cfg = this.d.cfg();
    const db = this.d.db;
    const input = this.gatherContext({ free: FREE_TIME_TEXT }, false);
    const preview = renderContext(input);
    const system = this.systemPrompt();
    const toolsText = JSON.stringify(this.d.tools.defs);
    const memText = input.memories.map((m) => `- #${m.id} [${m.subject}] ${m.content}`).join("\n");
    const sumText = input.summaries.map((s) => s.summary).join("\n");
    const blockLines = input.blocks.map((b) => formatLines(b.messages, { selfId: input.selfId }));
    const othersLines = input.others.map((o) => formatLines(o.messages, { selfId: input.selfId }));
    const tok = (t: string) => estimateTokens(t);
    return {
      tokens: {
        tools: tok(toolsText),
        system: tok(system),
        memories: tok(memText),
        summaries: tok(sumText),
        blocks: tok(blockLines.flat().join("\n")),
        others: tok(othersLines.flat().join("\n")),
        total: tok(toolsText) + tok(preview) + tok(system),
      },
      system,
      toolsChars: toolsText.length,
      memories: { items: input.memories, chars: db.memoryChars(), limit: cfg.memory.maxMemoryChars },
      summaries: input.summaries.filter((s) => s.summary.trim()),
      blocks: input.blocks.map((b, i) => ({
        space: b.space,
        title: b.title,
        count: b.messages.length,
        max: cfg.memory.maxMessages,
        compactEvery: cfg.memory.compactMessages,
        lines: blockLines[i]!,
        tokens: tok(blockLines[i]!.join("\n")),
      })),
      others: input.others.map((o, i) => ({
        space: o.space,
        title: o.title,
        shown: o.messages.length,
        unseen: db.unseenCount(o.space),
        mergeAt: MERGE_UNSEEN_AT,
        lines: othersLines[i]!,
      })),
      busy: this.busy,
      queued: this.queue.length,
      preview,
    };
  }

  private async respond(space: string) {
    const db = this.d.db;
    const unseen = db.unseen(space);
    if (!unseen.length) return;
    const shown = unseen.slice(-MAX_PENDING);
    const text = this.buildContext({ active: { space, pending: shown, hidden: unseen.length - shown.length } });

    const images = this.pendingImages.get(space) ?? [];
    this.pendingImages.delete(space);
    const user: ChatMessage = {
      role: "user",
      content: images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : text,
    };
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt() }, user];
    const finalText = await this.runLoop(messages, { space, triggerSenderIds: [...new Set(unseen.map((m) => m.senderId))] });

    // 处理成功才算「看过」:这批新消息并入这个会话的块,接着是她发出去的回复(addMessage 会给自己的消息直接编号)
    db.markIncluded(unseen.map((m) => m.id));
    const out = parseOutput(finalText);
    if (out.length) {
      await this.sendAll(space, out);
      this.lastSpoke.set(space, this.nowSec());
    }
  }

  private async doWander(event?: string): Promise<string> {
    const free = event ? `刚刚发生了一件事:\n${event}\n\n你可以据此做点什么(比如处理请求、通知相关的人、继续后续工作),也可以只是记下来。` : FREE_TIME_TEXT;
    const text = this.buildContext({ free });
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt() },
      { role: "user", content: text },
    ];
    const out = await this.runLoop(messages, { space: "self", triggerSenderIds: [] });
    return out.replace(/<\/?silent\s*\/?>/g, "").trim();
  }

  /** 调用模型并处理工具调用,直到模型给出最终文字。思考内容只在这个循环里往返带着,循环结束就丢 */
  private async runLoop(messages: ChatMessage[], ctx: ToolContext): Promise<string> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await this.callModel(messages);
      messages.push(msg);
      if (!msg.tool_calls?.length) return textOf(msg);
      for (const call of msg.tool_calls) {
        const out = await this.d.tools.run(call.function.name, call.function.arguments, ctx);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
    return "";
  }

  private async callModel(messages: ChatMessage[]): Promise<ChatMessage> {
    const cfg = this.d.cfg();
    const opts = { model: cfg.llm.model, thinking: cfg.llm.thinking, tools: this.d.tools.defs };
    if (this.noReasoning) return (await this.d.llm.chat({ ...opts, messages: stripAllReasoning(messages) })).message;
    try {
      return (await this.d.llm.chat({ ...opts, messages })).message;
    } catch (e) {
      if (!(e instanceof LlmError) || e.status !== 400 || !/reasoning/i.test(e.body ?? "")) throw e;
      this.noReasoning = true;
      this.log("API rejected reasoning_content; stopping passback");
      return (await this.d.llm.chat({ ...opts, messages: stripAllReasoning(messages) })).message;
    }
  }

  // ───────────── 发消息 ─────────────

  /** 主动向某个会话发消息(工具和自主行动用),返回实际发出的条数 */
  async say(space: string, raw: string): Promise<number> {
    const out = parseOutput(raw);
    if (!out.length) return 0;
    const sent = await this.sendAll(space, out);
    if (sent) this.lastSpoke.set(space, this.nowSec());
    return sent;
  }

  private async sendAll(space: string, out: OutMessage[]): Promise<number> {
    let sent = 0;
    const cfg = this.d.cfg();
    const sleep = this.d.sleep ?? ((ms: number) => Bun.sleep(ms));
    for (const msg of out) {
      const wait = Math.min(cfg.behavior.maxTypingMs, plainLength(msg) * cfg.behavior.typingMsPerChar);
      if (wait > 0) await sleep(wait);
      const segs: Segment[] = [];
      const labels: string[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") {
          segs.push(seg.text(part.text));
          labels.push(part.text);
        } else if (part.type === "at") {
          segs.push(seg.at(part.id));
          labels.push(`@${part.id}`);
        } else if (part.type === "face") {
          segs.push(seg.face(part.id));
          labels.push(`[QQ表情:${part.id}]`);
        } else if (part.type === "reply") {
          segs.unshift(seg.reply(part.id));
        } else if (this.d.media) {
          const r = await this.d.media.resolveOut(part, space);
          if (r) {
            segs.push(r.segment);
            labels.push(r.label);
          }
        }
      }
      if (!segs.some((s) => s.type !== "reply")) continue;
      try {
        const id = await this.d.napcat.send(space as SpaceId, segs);
        sent++;
        this.d.db.addMessage({
          space,
          msgId: id,
          ts: this.nowSec(),
          senderId: this.d.napcat.selfId ?? 0,
          senderName: "我",
          role: "self",
          text: labels.join(""),
        });
      } catch (e) {
        this.log(`send failed in ${space}: ${e}`);
      }
    }
    return sent;
  }

  // ───────────── 整理 ─────────────

  /** 每件事处理完之后:近期消息涨满就整理摘要,长期记忆太长就合并 */
  private async maintain() {
    const cfg = this.d.cfg();
    const db = this.d.db;
    for (const space of db.listSpaces()) {
      if (db.includedCount(space) < cfg.memory.maxMessages) continue;
      try {
        await compactSpace(db, this.d.llm, cfg.llm.lightModel, space, cfg.memory.maxMessages, cfg.memory.compactMessages);
      } catch (e) {
        this.log(`summarize failed for ${space}: ${e}`);
      }
    }
    // 整理失败后隔一阵再试,不要每件事都重试
    if (db.memoryChars() > cfg.memory.maxMemoryChars && Date.now() - this.lastConsolidateFail > 30 * 60_000) {
      try {
        if (!(await consolidateMemories(db, this.d.llm, cfg.llm.lightModel, cfg.memory.maxMemoryChars))) this.lastConsolidateFail = Date.now();
      } catch (e) {
        this.lastConsolidateFail = Date.now();
        this.log(`memory consolidation failed: ${e}`);
      }
    }
  }
}

export type { StoredMessage };
