import type { Config } from "../config";
import { LlmClient, LlmError, flattenHistory, stripAllReasoning, textOf, type ChatMessage } from "../llm/client";
import type { Db, StoredMessage } from "../memory/db";
import { maybeSummarize } from "../memory/summarize";
import { isMessageEvent } from "../napcat/client";
import { displayName, parseMessage, seg, type ParsedMessage } from "../napcat/parse";
import { parseSpace, spaceOf, type OneBotEvent, type Segment, type SpaceId } from "../napcat/types";
import { judgeReply } from "./judge";
import { parseOutput, plainLength, type OutMessage, type OutPart } from "./output";
import { buildSystemPrompt, formatNewMessages } from "./prompt";
import type { ToolRegistry } from "./tools";

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
  lastSpoke: number | null;
}

const MAX_TOOL_ROUNDS = 8;
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
    if (!s) this.states.set(space, (s = { running: false, dirty: false, mentioned: false, lastSpoke: null }));
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
    const st = this.state(space);
    st.dirty = true;
    st.mentioned ||= mentioned;
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
        st.mentioned = false;
        try {
          if (await this.shouldReply(space, mentioned)) await this.respond(space);
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
    const lastSender = pending.at(-1)!.senderId;

    const system = buildSystemPrompt({
      persona: cfg.persona,
      space,
      spaceTitle: row.title,
      isGroup: parseSpace(space).type === "group",
      summary: row.summary,
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
    const ctx = { space, triggerSenderIds: senders, isAdmin: cfg.admins.includes(lastSender) };
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.callModel(messages, history.length + 1);
      const msg = res;
      turn.push(msg);
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        finalText = textOf(msg);
        break;
      }
      for (const call of msg.tool_calls) {
        const out = await this.d.tools.run(call.function.name, call.function.arguments, ctx);
        const toolMsg: ChatMessage = { role: "tool", tool_call_id: call.id, content: out };
        turn.push(toolMsg);
        messages.push(toolMsg);
      }
    }

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

  private async sendAll(space: string, out: OutMessage[]) {
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
  }
}

export type { StoredMessage };
