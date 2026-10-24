import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { parseJudge } from "../src/agent/judge";
import { parseOutput } from "../src/agent/output";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig, type Config } from "../src/config";
import { LlmClient, flattenHistory, type ChatMessage } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { maybeSummarize } from "../src/memory/summarize";
import { seg } from "../src/napcat/parse";
import type { OneBotEvent, Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Script = (body: any, n: number) => { message: ChatMessage; status?: number } | { status: number; error: string };

function mockLlm(script: Script) {
  const calls: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      calls.push(body);
      const r: any = script(body, calls.length);
      if (r.error) return new Response(r.error, { status: r.status });
      return Response.json({ choices: [{ message: r.message, finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const llm = new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 }));
  return { llm, calls };
}

function fakeNapcat() {
  const sent: Array<{ space: string; message: Segment[] }> = [];
  let id = 1000;
  return {
    selfId: 100,
    sent,
    async send(space: SpaceId, message: Segment[]) {
      sent.push({ space, message });
      return ++id;
    },
    async call<T>(action: string): Promise<T> {
      if (action === "get_group_info") return { group_name: "测试群" } as T;
      return {} as T;
    },
  };
}

const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : "");

function setup(script: Script, cfgPatch: Partial<Config> = {}) {
  const { llm, calls } = mockLlm(script);
  const db = new Db(":memory:");
  const napcat = fakeNapcat();
  const cfg = mergeConfig(defaultConfig, { behavior: { typingMsPerChar: 0 }, ...cfgPatch });
  const agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm,
    tools: new ToolRegistry(memoryTools(db)),
    sleep: async () => {},
    log: () => {},
  });
  return { agent, db, napcat, calls };
}

let mid = 0;
function privateMsg(userId: number, t: string): OneBotEvent {
  return { post_type: "message", message_type: "private", message_id: ++mid, user_id: userId, self_id: 100, time: 1700000000 + mid, message: [seg.text(t)], sender: { nickname: `u${userId}` } };
}
function groupMsg(groupId: number, userId: number, segs: any[]): OneBotEvent {
  return { post_type: "message", message_type: "group", group_id: groupId, message_id: ++mid, user_id: userId, self_id: 100, time: 1700000000 + mid, message: segs, sender: { nickname: `u${userId}` } };
}

const reply = (content: string, extra: Partial<ChatMessage> = {}): { message: ChatMessage } => ({ message: { role: "assistant", content, ...extra } });

describe("output parsing", () => {
  test("多条消息、@、回复、媒体", () => {
    const out = parseOutput('<msg><reply id="5"/>好的<at id="9"/></msg><msg>第二条</msg><msg><sticker id="3"/></msg>');
    expect(out).toHaveLength(3);
    expect(out[0]!.parts).toEqual([
      { type: "reply", id: "5" },
      { type: "text", text: "好的" },
      { type: "at", id: "9" },
    ]);
    expect(out[2]!.parts).toEqual([{ type: "media", kind: "sticker", ref: "3" }]);
  });
  test("无标签当一条、silent 不回复", () => {
    expect(parseOutput("你好")).toEqual([{ parts: [{ type: "text", text: "你好" }] }]);
    expect(parseOutput("<silent/>")).toEqual([]);
    expect(parseOutput("  ")).toEqual([]);
  });
  test("judge 解析", () => {
    expect(parseJudge('{"reply": true}')).toBe(true);
    expect(parseJudge('{"reply":false}')).toBe(false);
    expect(parseJudge("乱七八糟")).toBe(false);
  });
});

describe("flattenHistory", () => {
  test("只保留最近 N 轮的思考内容", () => {
    const rounds: ChatMessage[][] = [1, 2, 3].map((i) => [
      { role: "user", content: `u${i}` },
      { role: "assistant", content: `a${i}`, reasoning_content: `r${i}` },
    ]);
    const flat = flattenHistory(rounds, 2);
    expect(flat.filter((m) => "reasoning_content" in m).map((m) => m.reasoning_content)).toEqual(["r2", "r3"]);
    expect(flat).toHaveLength(6);
  });
});

describe("Agent", () => {
  test("私聊:调用模型并把多条消息分开发送", async () => {
    const { agent, db, napcat, calls } = setup(() => reply("<msg>在的</msg><msg>什么事?</msg>"));
    await agent.handleEvent(privateMsg(7, "在吗"));
    await agent.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe("system");
    expect(text(calls[0].messages.at(-1))).toContain("u7(7): 在吗");
    expect(napcat.sent.map((s) => s.message)).toEqual([[seg.text("在的")], [seg.text("什么事?")]]);
    expect(db.recent("p:7", 10).map((m) => m.role)).toEqual(["user", "self", "self"]);
  });

  test("群聊:被 @ 不走判定,直接回复", async () => {
    const { agent, napcat, calls } = setup(() => reply("<msg>来了</msg>"));
    await agent.handleEvent(groupMsg(5, 7, [seg.at(100), seg.text(" 帮个忙")]));
    await agent.idle();
    expect(calls).toHaveLength(1); // 只有主模型一次调用
    expect(napcat.sent).toHaveLength(1);
  });

  test("群聊:判定为否则不回复,判定为是则回复", async () => {
    let judge = false;
    const { agent, napcat, calls } = setup((body) =>
      body.max_tokens === 30 ? reply(`{"reply": ${judge}}`) : reply("<msg>插一句</msg>"),
    );
    await agent.handleEvent(groupMsg(5, 7, [seg.text("今天天气不错")]));
    await agent.idle();
    expect(napcat.sent).toHaveLength(0);
    expect(calls).toHaveLength(1);

    judge = true;
    await agent.handleEvent(groupMsg(5, 8, [seg.text("有人知道怎么装 git 吗")]));
    await agent.idle();
    expect(napcat.sent).toHaveLength(1);
    // 主模型这次能同时看到之前没回复的那条消息
    const main = calls.at(-1);
    expect(text(main.messages.at(-1))).toContain("今天天气不错");
    expect(text(main.messages.at(-1))).toContain("有人知道怎么装 git 吗");
  });

  test("工具循环:remember 落库,且回传同一轮的思考内容", async () => {
    const { agent, db, calls } = setup((body, n) =>
      n === 1
        ? reply("", {
            reasoning_content: "先记一下",
            tool_calls: [{ id: "c1", type: "function", function: { name: "remember", arguments: JSON.stringify({ subject: "user:7", content: "7 喜欢猫" }) } }],
          })
        : reply("<msg>记住啦</msg>"),
    );
    await agent.handleEvent(privateMsg(7, "我喜欢猫"));
    await agent.idle();
    expect(db.memoriesFor(["user:7"]).map((m) => m.content)).toEqual(["7 喜欢猫"]);
    const second = calls[1].messages;
    const assistant = second.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("先记一下");
    expect(second.at(-1).role).toBe("tool");
  });

  test("跨空间记忆:群里记下的事,私聊提示词里能看到", async () => {
    const { agent, db, calls } = setup(() => reply("<msg>ok</msg>"));
    db.addMemory("user:7", "7 是后端工程师");
    await agent.handleEvent(privateMsg(7, "你好"));
    await agent.idle();
    expect(text(calls[0].messages[0])).toContain("7 是后端工程师");
  });

  test("历史轮次被保留,并只回传最近 N 轮思考内容", async () => {
    const { agent, calls } = setup((_b, n) => reply(`<msg>回${n}</msg>`, { reasoning_content: `想${n}` }), {
      llm: { reasoningRounds: 1 } as any,
    });
    for (const t of ["一", "二", "三"]) {
      await agent.handleEvent(privateMsg(7, t));
      await agent.idle();
    }
    const last = calls[2].messages;
    expect(last.filter((m: any) => m.role === "user")).toHaveLength(3);
    const withReasoning = last.filter((m: any) => m.reasoning_content).map((m: any) => m.reasoning_content);
    expect(withReasoning).toEqual(["想2"]);
  });

  test("接口拒绝历史思考内容时自动降级重试", async () => {
    let first = true;
    const { agent, napcat } = setup((body) => {
      const hasReasoning = body.messages.some((m: any) => m.reasoning_content);
      if (hasReasoning) return { status: 400, error: "reasoning_content must not be passed" };
      first = false;
      return reply("<msg>好</msg>", { reasoning_content: "想" });
    });
    await agent.handleEvent(privateMsg(7, "一"));
    await agent.idle();
    await agent.handleEvent(privateMsg(7, "二"));
    await agent.idle();
    expect(first).toBe(false);
    expect(napcat.sent).toHaveLength(2);
  });
});

describe("summarize", () => {
  test("超出窗口的旧消息被整合进摘要并清理旧轮次", async () => {
    const { llm, calls } = mockLlm(() => reply("摘要:7 喜欢猫"));
    const db = new Db(":memory:");
    for (let i = 1; i <= 130; i++) db.addMessage({ space: "p:7", msgId: i, ts: i, senderId: 7, senderName: "u7", role: "user", text: `m${i}` });
    db.addTurn("p:7", 1, 40, [{ role: "user", content: "old" }]);
    db.addTurn("p:7", 41, 130, [{ role: "user", content: "new" }]);
    const did = await maybeSummarize(db, llm, "m", "p:7", 50);
    expect(did).toBe(true);
    expect(db.getSpace("p:7").summary).toContain("喜欢猫");
    expect(db.turns("p:7")).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages)).toContain("m1");
    expect(JSON.stringify(calls[0].messages)).not.toContain("m100");
    // 再调用一次不会重复摘要
    expect(await maybeSummarize(db, llm, "m", "p:7", 50)).toBe(false);
  });
});
