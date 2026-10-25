import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { parseJudge } from "../src/agent/judge";
import { parseOutput } from "../src/agent/output";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig, type Config } from "../src/config";
import { LlmClient, type ChatMessage } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { compactSpace } from "../src/memory/summarize";
import { seg } from "../src/napcat/parse";
import type { OneBotEvent, Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Script = (body: any, n: number) => { message: ChatMessage; status?: number } | { status: number; error: string };

function mockLlm(script: Script) {
  const calls: any[] = [];
  const stats = { active: 0, maxConcurrent: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      stats.active++;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.active);
      try {
        const body = await req.json();
        calls.push(body);
        const r: any = script(body, calls.length);
        if (r.delay) await Bun.sleep(r.delay);
        if (r.error) return new Response(r.error, { status: r.status });
        return Response.json({ choices: [{ message: r.message, finish_reason: "stop" }] });
      } finally {
        stats.active--;
      }
    },
  });
  cleanups.push(() => server.stop(true));
  const llm = new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 }));
  return { llm, calls, stats };
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
  const { llm, calls, stats } = mockLlm(script);
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
  return { agent, db, napcat, calls, stats };
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

  test("所有记忆都在上下文里,不管记在谁名下", async () => {
    const { agent, db, calls } = setup(() => reply("<msg>ok</msg>"));
    db.addMemory("user:7", "7 是后端工程师");
    db.addMemory("user:8", "8 喜欢爬山");
    db.addMemory("space:g:5", "这个群周五聚餐");
    await agent.handleEvent(privateMsg(7, "你好"));
    await agent.idle();
    const ctx = text(calls[0].messages.at(-1));
    expect(ctx).toContain("7 是后端工程师");
    expect(ctx).toContain("8 喜欢爬山");
    expect(ctx).toContain("这个群周五聚餐");
    // 系统提示词里没有会变的东西(时间、记忆),这样每次请求开头都一样
    expect(text(calls[0].messages[0])).not.toContain("7 是后端工程师");
    expect(text(calls[0].messages[0])).not.toMatch(/现在是 \d{4}/);
  });

  test("第二次请求能看到第一次的聊天和自己的回复,但没有任何思考内容", async () => {
    const { agent, calls } = setup((_b, n) => reply(`<msg>回${n}</msg>`, { reasoning_content: `想${n}` }));
    for (const t of ["一", "二"]) {
      await agent.handleEvent(privateMsg(7, t));
      await agent.idle();
    }
    const second = calls[1].messages;
    expect(second).toHaveLength(2); // 系统提示词 + 一整块上下文
    const ctx = text(second.at(-1));
    expect(ctx).toContain("u7(7): 一");
    expect(ctx).toContain("我: 回1");
    expect(ctx).toContain("u7(7): 二"); // 新消息在「现在」里,带 #消息ID
    expect(second.some((m: any) => m.reasoning_content)).toBe(false);
  });

  test("接口拒绝回传思考内容时,自动去掉后重试,并且之后都不再带", async () => {
    let calls = 0;
    const { agent, napcat } = setup((body) => {
      calls++;
      if (body.messages.some((m: any) => m.reasoning_content)) return { status: 400, error: "reasoning_content must not be passed" };
      if (calls === 1) return reply("", { reasoning_content: "想", tool_calls: [{ id: "c1", type: "function", function: { name: "recall", arguments: '{"query":"x"}' } }] });
      return reply("<msg>好</msg>");
    });
    await agent.handleEvent(privateMsg(7, "一"));
    await agent.idle();
    expect(napcat.sent).toHaveLength(1);
  });

  test("全局排队:一次只处理一件事,先来后到", async () => {
    const order: string[] = [];
    const { agent, napcat, stats } = setup((body) => {
      // 所有会话的内容都在上下文里,所以看「现在要处理的是哪个会话」
      const ctx = JSON.stringify(body.messages.at(-1));
      order.push(ctx.includes("现在要处理的是 私聊「u11」") ? "甲" : "乙");
      return { ...reply("<msg>ok</msg>"), delay: 60 } as any;
    });
    await agent.handleEvent(privateMsg(11, "来自私聊甲"));
    await agent.handleEvent(privateMsg(12, "来自私聊乙")); // 甲还在处理,乙排队
    await agent.idle();
    expect(stats.maxConcurrent).toBe(1);
    expect(order).toEqual(["甲", "乙"]);
    expect(napcat.sent.map((s) => s.space)).toEqual(["p:11", "p:12"]);
  });

  test("处理甲的时候乙来的新消息,乙的上下文里能看到甲的聊天", async () => {
    const { agent, calls } = setup(() => reply("<msg>ok</msg>"));
    await agent.handleEvent(privateMsg(11, "甲说了一句悄悄话"));
    await agent.idle();
    await agent.handleEvent(privateMsg(12, "乙来问问"));
    await agent.idle();
    const ctx = text(calls[1].messages.at(-1));
    expect(ctx).toContain("甲说了一句悄悄话"); // 其他会话的内容也在上下文里
    // 当前处理的乙排在最后
    expect(ctx.indexOf("p:11")).toBeLessThan(ctx.indexOf("p:12"));
    expect(ctx).toMatch(/现在要处理的是 私聊「u12」 p:12/);
  });
});

describe("summarize", () => {
  test("近期消息涨满后,最老的一批整合进摘要,之后保持在区间内", async () => {
    const { llm, calls } = mockLlm(() => reply("摘要:7 喜欢猫"));
    const db = new Db(":memory:");
    for (let i = 1; i <= 130; i++) {
      db.addMessage({ space: "p:7", msgId: i, ts: 1700000000 + i, senderId: 7, senderName: "u7", role: "user", text: `m${i}` });
    }
    db.markIncluded(db.unseen("p:7").map((m) => m.id));
    expect(db.includedCount("p:7")).toBe(130);
    expect(await compactSpace(db, llm, "m", "p:7", 150, 100)).toBe(false); // 还没涨满,不整理
    expect(await compactSpace(db, llm, "m", "p:7", 120, 100)).toBe(true);
    expect(db.getSpace("p:7").summary).toContain("喜欢猫");
    expect(db.includedCount("p:7")).toBe(30);
    expect(db.included("p:7")[0]!.text).toBe("m101");
    expect(JSON.stringify(calls[0].messages)).toContain("m1");
    expect(JSON.stringify(calls[0].messages)).toContain("m100");
    expect(JSON.stringify(calls[0].messages)).not.toContain("m101");
    // 整理之后不够数了,再调用不会重复整理
    expect(await compactSpace(db, llm, "m", "p:7", 120, 100)).toBe(false);
  });
});
