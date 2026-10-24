import { afterEach, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { buildSystemPrompt } from "../src/agent/prompt";
import { Scheduler, inQuietHours, nextDelayMs } from "../src/agent/scheduler";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig } from "../src/config";
import { LlmClient, type ChatMessage } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { chatTools } from "../src/tools/chat";
import type { Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test("下次行动的间隔在 ±30% 内浮动", () => {
  expect(nextDelayMs(100, () => 0)).toBe(70 * 60_000);
  expect(nextDelayMs(100, () => 1)).toBe(130 * 60_000);
  expect(nextDelayMs(0, () => 0.5)).toBe(60_000); // 间隔至少 1 分钟
});

test("安静时段:普通、跨午夜、不设置", () => {
  const at = (h: number) => new Date(2026, 0, 1, h, 30);
  expect(inQuietHours(at(3), 1, 8)).toBe(true);
  expect(inQuietHours(at(8), 1, 8)).toBe(false);
  expect(inQuietHours(at(0), 1, 8)).toBe(false);
  expect(inQuietHours(at(23), 23, 7)).toBe(true);
  expect(inQuietHours(at(2), 23, 7)).toBe(true);
  expect(inQuietHours(at(12), 23, 7)).toBe(false);
  expect(inQuietHours(at(3), 5, 5)).toBe(false);
});

test("调度器:关闭或安静时段不行动,否则行动;出错不会抛出", async () => {
  let runs = 0;
  let enabled = true;
  let hour = 12;
  const s = new Scheduler({
    enabled: () => enabled,
    intervalMinutes: () => 60,
    quiet: () => [1, 8],
    run: async () => {
      runs++;
      if (runs === 3) throw new Error("boom");
    },
    now: () => new Date(2026, 0, 1, hour),
    log: () => {},
  });
  expect(await s.tick()).toBe(true);
  enabled = false;
  expect(await s.tick()).toBe(false);
  enabled = true;
  hour = 3;
  expect(await s.tick()).toBe(false);
  hour = 12;
  expect(await s.tick()).toBe(true);
  expect(runs).toBe(2);
  expect(await s.tick()).toBe(true); // 第 3 次 run 抛错,但 tick 不会抛出
  expect(runs).toBe(3);
});

test("提示词里有主人和边界;没有主人时平等对待", () => {
  const base = { persona: "p", space: "p:1", spaceTitle: "t", isGroup: false, summary: "", memories: [], otherSummaries: [], extraSections: [], now: new Date() };
  expect(buildSystemPrompt({ ...base, owners: [10001, 10002] })).toContain("主人的 QQ 号:10001、10002");
  expect(buildSystemPrompt({ ...base, owners: [] })).toContain("还没有指定主人");
  expect(buildSystemPrompt({ ...base, owners: [], scene: "当前场景:自由时间" })).toContain("当前场景:自由时间");
});

function setup(script: (body: any, n: number) => ChatMessage) {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      return Response.json({ choices: [{ message: script(body, bodies.length), finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const db = new Db(":memory:");
  const sent: Array<{ space: string; message: Segment[] }> = [];
  const napcat = {
    selfId: 100,
    async send(space: SpaceId, message: Segment[]) {
      sent.push({ space, message });
      return 5000 + sent.length;
    },
    async call<T>(): Promise<T> {
      return {} as T;
    },
  };
  const cfg = mergeConfig(defaultConfig, { behavior: { typingMsPerChar: 0 }, admins: [10001] });
  const holder: { agent?: Agent } = {};
  const tools = new ToolRegistry([...memoryTools(db), ...chatTools({ db, say: (s, r) => holder.agent!.say(s, r) })]);
  const agent = (holder.agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm: new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 })),
    tools,
    sleep: async () => {},
    log: () => {},
  }));
  return { agent, db, sent, bodies };
}

const call = (name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: "",
  reasoning_content: "想想",
  tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

test("自由时间:模型自己决定主动给群里发消息,并记住这次行动", async () => {
  const t = setup((_b, n) =>
    n === 1 ? call("send_message", { space: "g:5", text: "<msg>大家早</msg><msg>今天有人打球吗</msg>" }) : n === 2 ? { role: "assistant", content: "去群里打了个招呼" } : { role: "assistant", content: "<silent/>" },
  );
  t.db.addMessage({ space: "g:5", msgId: 1, ts: 1700000000, senderId: 7, senderName: "小七", role: "user", text: "昨天的球赛太精彩了" });
  t.db.setTitle("g:5", "球友群");

  const said = await t.agent.wander();
  expect(said).toBe("去群里打了个招呼");
  // 主动发出了两条消息
  expect(t.sent.map((s) => [s.space, (s.message[0]!.data as any).text])).toEqual([
    ["g:5", "大家早"],
    ["g:5", "今天有人打球吗"],
  ]);
  // 模型看到了自己的工具和各个聊天的动静
  const first = t.bodies[0];
  const toolNames = first.tools.map((x: any) => x.function.name);
  expect(toolNames).toContain("send_message");
  expect(toolNames).toContain("list_chats");
  expect(JSON.stringify(first.messages)).toContain("球友群");
  expect(JSON.stringify(first.messages[0])).toContain("自主行动");
  expect(JSON.stringify(first.messages[0])).toContain("10001");
  // 主动发出的消息也记进了那个群的聊天记录
  expect(t.db.recent("g:5", 10).map((m) => m.text)).toEqual(["昨天的球赛太精彩了", "大家早", "今天有人打球吗"]);

  // 下一次自由时间带着上次的经历,选择什么都不做
  expect(await t.agent.wander()).toBe("");
  const second = JSON.stringify(t.bodies.at(-1).messages);
  expect(second).toContain("去群里打了个招呼");
  expect(t.sent).toHaveLength(2);
});

test("事件唤醒:把事件内容交给模型", async () => {
  const t = setup(() => ({ role: "assistant", content: "<silent/>" }));
  await t.agent.wander("[OpenCode 任务 #3 已完成]\n结果:脚本写好了");
  expect(JSON.stringify(t.bodies[0].messages.at(-1))).toContain("脚本写好了");
});

test("send_message 工具:校验会话格式,list_chats 列出聊天", async () => {
  const t = setup(() => ({ role: "assistant", content: "ok" }));
  t.db.addMessage({ space: "p:9", msgId: 1, ts: 1700000000, senderId: 9, senderName: "九", role: "user", text: "在吗" });
  const reg = new ToolRegistry(chatTools({ db: t.db, say: async () => 1 }));
  const ctx = { space: "self", triggerSenderIds: [] };
  expect(await reg.run("send_message", '{"space":"bogus","text":"x"}', ctx)).toContain("格式不对");
  expect(await reg.run("send_message", '{"space":"p:9","text":"x"}', ctx)).toBe("已发送 1 条");
  expect(await reg.run("list_chats", "{}", ctx)).toContain("p:9");
});
