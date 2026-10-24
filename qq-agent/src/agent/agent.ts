import type { Config } from "../config";
import { LlmClient, LlmError, flattenHistory, stripAllReasoning, textOf, type ChatMessage } from "../llm/client";
import type { Db, StoredMessage } from "../memory/db";
import { maybeSummarize } from "../memory/summarize";
import { isMessageEvent } from "../napcat/client";
import { displayName, parseMessage, seg, type ParsedMessage } from "../napcat/parse";
import { parseSpace, spaceOf, type OneBotEvent, type Segment, type SpaceId } from "../napcat/types";
import { judgeReply } from "./judge";
import { parseOutput, plainLength, type OutMessage, type OutPart } from "./output";
import { buildSystemPrompt, formatNewMessages, formatTime } from "./prompt";
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

interface SpaceState {
  running: boolean;
  dirty: boolean;
  mentioned: boolean;
  /** 系统通知触发:必须让模型处理,不走群聊判定 */
  forced: boolean;
  lastSpoke: number | null;
}

const MAX_TOOL_ROUNDS = 8;

const AUTONOMY_SECTION = [
  "# 自主行动",
  "你不只是被动回复:有人找你时你回应他们,没人找你时你也有自己的生活——发动态、改签名和状态、整理表情包、主动找朋友聊两句、跟进之前答应过的事。",
  "但要克制:",
  "- 主动找人要有理由(跟进某件事、分享有意思的东西、很久没聊的熟人),别无缘无故刷存在感,别连发,别在群里无话找话。",
  "- 动态别发太频繁,内容要符合你的人设;发之前 recall 一下最近发过什么。",
  "- 做完什么用 remember 记一笔(subject 写 global),下次才知道自己做过什么。",
  "- 没什么想做的就什么都不做,输出 <silent/> 即可。这完全正常。",
].join("\n");
const MAX_PENDING = 60;

export class Agent {
  private states = new Map<string, SpaceState>();
  private inflight = new Set<Promise<void>>();
  private pendingImages = new Map<string, string[]>();
  /** 接口拒绝历史轮次里的思考内容时置位,之后不再回传历史思考 */
  private rejectHistoryReasoning = false;

  constructor(private d: AgentDeps) {}

  private log(m: string) {
    (this.d.log ?? console.log)(`[agent] ${m}`);
  }

  private nowSec(): number {
    return Math.floor((this.d.now?.() ?? Date.now()) / 1000);
  }

  private state(space: string): SpaceState {
    let s = this.states.get(space);
    if (!s) this.states.set(space, (s = { running: false, dirty: false, mentioned: false, forced: false, lastSpoke: null }));
    return s;
  }

  /** 等所有进行中的处理结束(测试用) */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async handleEvent(ev: OneBotEvent): Promise<void> {
    if (!isMessageEvent(ev)) return;
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
    this.trigger(space, mentioned, false);
  }

  /** 系统事件(例如 OpenCode 任务完成):写入一条系统消息并让模型处理,由模型决定怎么向用户汇报 */
  notify(space: string, text: string): void {
    this.d.db.addMessage({ space, msgId: null, ts: this.nowSec(), senderId: 0, senderName: "系统", role: "user", text });
    this.trigger(space, true, true);
  }

  private trigger(space: string, mentioned: boolean, forced: boolean) {
    const st = this.state(space);
    st.dirty = true;
    st.mentioned ||= mentioned;
    st.forced ||= forced;
    if (!st.running) {
      st.running = true;
      const p = this.drain(space).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
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

  private async drain(space: string) {
    const st = this.state(space);
    try {
      while (st.dirty) {
        st.dirty = false;
        const mentioned = st.mentioned;
        const forced = st.forced;
        st.mentioned = false;
        st.forced = false;
        try {
          if (forced || (await this.shouldReply(space, mentioned))) await this.respond(space);
        } catch (e) {
          this.log(`error in ${space}: ${e instanceof Error ? e.stack ?? e.message : e}`);
        }
      }
    } finally {
      st.running = false;
    }
  }

  private async shouldReply(space: string, mentioned: boolean): Promise<boolean> {
    const cfg = this.d.cfg();
    if (parseSpace(space).type === "private") return true;
    if (mentioned && cfg.group.alwaysReplyWhenMentioned) return true;
    const st = this.state(space);
    const since = st.lastSpoke == null ? null : this.nowSec() - st.lastSpoke;
    if (since != null && since < cfg.group.cooldownSeconds) return false;
    return judgeReply(this.d.llm, cfg.llm.lightModel, {
      persona: cfg.persona,
      context: this.d.db.recent(space, cfg.group.judgeContext),
      sinceLastSpokeSec: since,
    });
  }

  private memorySubjects(space: string, senders: number[]): string[] {
    const subjects = new Set<string>(["global", `space:${space}`]);
    for (const s of senders) subjects.add(`user:${s}`);
    return [...subjects];
  }

  private async respond(space: string) {
    const cfg = this.d.cfg();
    const db = this.d.db;
    const row = db.getSpace(space);
    const pending = db.messagesAfter(space, row.llmCursor, MAX_PENDING).filter((m) => m.role === "user");
    if (!pending.length) return;
    const firstRow = pending[0]!.id;
    const lastRow = pending.at(-1)!.id;
    const senders = [...new Set(pending.map((m) => m.senderId))];

    const system = buildSystemPrompt({
      persona: cfg.persona,
      space,
      spaceTitle: row.title,
      isGroup: parseSpace(space).type === "group",
      summary: row.summary,
      admins: cfg.admins,
      memories: db.memoriesFor(this.memorySubjects(space, senders)).slice(-40),
      otherSummaries: db.otherSpaceSummaries(space),
      extraSections: [...(this.d.extraSections?.() ?? []), ...(this.d.media?.promptSection ? [this.d.media.promptSection()] : [])],
      now: new Date((this.d.now?.() ?? Date.now())),
    });

    const history = flattenHistory(
      db.turns<ChatMessage>(space),
      this.rejectHistoryReasoning ? 0 : cfg.llm.reasoningRounds,
    );
    const userText = formatNewMessages(pending);
    const images = this.pendingImages.get(space) ?? [];
    this.pendingImages.delete(space);
    const liveUser: ChatMessage = {
      role: "user",
      content: images.length
        ? [{ type: "text", text: userText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : userText,
    };
    const storedUser: ChatMessage = { role: "user", content: userText };

    const turn: ChatMessage[] = [];
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...history, liveUser];
    const finalText = await this.runLoop(messages, turn, history.length + 1, { space, triggerSenderIds: senders });

    db.addTurn(space, firstRow, lastRow, [storedUser, ...turn]);
    db.setCursor(space, lastRow);

    const out = parseOutput(finalText);
    if (out.length) {
      await this.sendAll(space, out);
      this.state(space).lastSpoke = this.nowSec();
    }

    try {
      await maybeSummarize(db, this.d.llm, cfg.llm.lightModel, space, cfg.memory.windowSize);
    } catch (e) {
      this.log(`summarize failed for ${space}: ${e}`);
    }
  }

  /** 调用模型并处理工具调用,直到模型给出最终文字。每条新消息会同时追加到 messages 和 turn */
  private async runLoop(messages: ChatMessage[], turn: ChatMessage[], historyEnd: number, ctx: ToolContext): Promise<string> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await this.callModel(messages, historyEnd);
      turn.push(msg);
      messages.push(msg);
      if (!msg.tool_calls?.length) return textOf(msg);
      for (const call of msg.tool_calls) {
        const out = await this.d.tools.run(call.function.name, call.function.arguments, ctx);
        const toolMsg: ChatMessage = { role: "tool", tool_call_id: call.id, content: out };
        turn.push(toolMsg);
        messages.push(toolMsg);
      }
    }
    return "";
  }

  /** 主动向某个会话发消息(工具和自主行动用),返回实际发出的条数 */
  async say(space: string, raw: string): Promise<number> {
    const out = parseOutput(raw);
    if (!out.length) return 0;
    const sent = await this.sendAll(space, out);
    if (sent) this.state(space).lastSpoke = this.nowSec();
    return sent;
  }

  private wandering = false;

  /**
   * 自由时间:没有人在说话,让 Agent 自己决定做点什么。
   * event 不为空时表示由某个事件唤醒(例如自己提交的 OpenCode 任务完成)。返回模型最后说的话(通常是它做了什么的小结)。
   */
  async wander(event?: string): Promise<string> {
    if (this.wandering) return "";
    this.wandering = true;
    try {
      const cfg = this.d.cfg();
      const db = this.d.db;
      const now = new Date(this.d.now?.() ?? Date.now());
      const system = buildSystemPrompt({
        persona: cfg.persona,
        space: "self",
        spaceTitle: "自由时间",
        isGroup: false,
        summary: "",
        admins: cfg.admins,
        scene: "当前场景:自由时间。现在没有人在跟你说话,你可以按自己的性格和心情决定做什么,也可以什么都不做。",
        memories: db.memoriesFor(["global"]).slice(-40),
        otherSummaries: db.otherSpaceSummaries("self"),
        extraSections: [...(this.d.extraSections?.() ?? []), ...(this.d.media?.promptSection ? [this.d.media.promptSection()] : []), AUTONOMY_SECTION],
        now,
      });
      const chats = db.listSpaces().map((sp) => {
        const row = db.getSpace(sp);
        const last = db.recent(sp, 1)[0];
        return `- ${sp}「${row.title || sp}」${last ? `,最后一条 ${formatTime(last.ts)} ${last.role === "self" ? "你" : last.senderName}: ${last.text.slice(0, 30)}` : ""}`;
      });
      const body = event
        ? `刚刚发生了一件事:\n${event}\n\n你可以据此做点什么(比如通知相关的人、继续后续工作),也可以只是记下来。`
        : [
            `现在是 ${now.toLocaleString("zh-CN", { hour12: false })}。这是你的自由时间。`,
            "你的聊天:",
            ...(chats.length ? chats : ["- (还没有任何聊天)"]),
            "可以做的事(不是任务清单,看心情,也可以什么都不做,那就只输出 <silent/>):发一条动态、改签名/状态/头像、主动找某个人或某个群说句话、整理图库、跟进之前记下的事、看看 OpenCode 任务进展。",
            "先用 recall 看看自己最近做过什么,别重复。",
          ].join("\n");
      const history = flattenHistory(db.turns<ChatMessage>("self").slice(-10), this.rejectHistoryReasoning ? 0 : cfg.llm.reasoningRounds);
      const user: ChatMessage = { role: "user", content: body };
      const turn: ChatMessage[] = [];
      const messages: ChatMessage[] = [{ role: "system", content: system }, ...history, user];
      const text = await this.runLoop(messages, turn, history.length + 1, { space: "self", triggerSenderIds: [] });
      db.addTurn("self", 0, 0, [user, ...turn]);
      db.trimTurns("self", 30);
      return text.replace(/<\/?silent\s*\/?>/g, "").trim();
    } finally {
      this.wandering = false;
    }
  }

  private async callModel(messages: ChatMessage[], historyEnd: number): Promise<ChatMessage> {
    const cfg = this.d.cfg();
    const opts = { model: cfg.llm.model, thinking: cfg.llm.thinking, tools: this.d.tools.defs };
    try {
      return (await this.d.llm.chat({ ...opts, messages })).message;
    } catch (e) {
      if (!(e instanceof LlmError) || e.status !== 400 || !/reasoning/i.test(e.body ?? "")) throw e;
      // 接口不接受回传的思考内容:先只去掉历史部分,仍不行再全部去掉
      if (!this.rejectHistoryReasoning) {
        this.rejectHistoryReasoning = true;
        this.log("API rejected reasoning_content in history; stopping history passback");
        const stripped = [...stripAllReasoning(messages.slice(0, historyEnd)), ...messages.slice(historyEnd)];
        try {
          return (await this.d.llm.chat({ ...opts, messages: stripped })).message;
        } catch (e2) {
          if (!(e2 instanceof LlmError) || e2.status !== 400 || !/reasoning/i.test(e2.body ?? "")) throw e2;
        }
      }
      return (await this.d.llm.chat({ ...opts, messages: stripAllReasoning(messages) })).message;
    }
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
}

export type { StoredMessage };
