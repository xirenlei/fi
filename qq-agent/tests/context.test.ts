import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent";
import { formatLines } from "../src/agent/context";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig } from "../src/config";
import { LlmClient } from "../src/llm/client";
import { consolidateMemories, parseConsolidation } from "../src/memory/consolidate";
import { Db, type StoredMessage } from "../src/memory/db";
import { seg } from "../src/napcat/parse";
import type { OneBotEvent, Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const BASE = 1_792_000_000; // 固定时间,避免跨日期带来的干扰

function setup(opts: { cfg?: object; judge?: boolean; summarize?: string; consolidate?: string } = {}) {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      bodies.push(body);
      const sys = JSON.stringify(body.messages[0]);
      let content = "<msg>ok</msg>";
      if (body.max_tokens === 30) content = `{"reply": ${opts.judge ?? false}}`;
      else if (sys.includes("整合进已有摘要")) content = opts.summarize ?? "摘要内容";
      else if (sys.includes("整理一个人的长期记忆笔记")) content = opts.consolidate ?? "[]";
      return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const db = new Db(":memory:");
  const sent: Array<{ space: string; message: Segment[] }> = [];
  let now = BASE * 1000;
  const napcat = {
    selfId: 100,
    async send(space: SpaceId, message: Segment[]) {
      sent.push({ space, message });
      return 9000 + sent.length;
    },
    async call<T>(): Promise<T> {
      return { group_name: "球友群" } as T;
    },
  };
  const cfg = mergeConfig(defaultConfig, { behavior: { typingMsPerChar: 0 }, ...opts.cfg });
  const agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm: new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 })),
    tools: new ToolRegistry(memoryTools(db)),
    sleep: async () => {},
    now: () => now,
    log: () => {},
  });
  let mid = 0;
  const say = async (space: string, user: number, text: string, name = `u${user}`) => {
    now += 60_000;
    const group = space.startsWith("g:");
    const ev = {
      post_type: "message",
      message_type: group ? "group" : "private",
      ...(group ? { group_id: Number(space.slice(2)) } : {}),
      message_id: ++mid,
      user_id: user,
      self_id: 100,
      time: Math.floor(now / 1000),
      message: [seg.text(text)],
      sender: { nickname: name },
    } as OneBotEvent;
    await agent.handleEvent(ev);
    await agent.idle();
  };
  /** 取第 n 次主模型请求(排除插嘴判定、摘要这类小请求)里那一大块上下文 */
  const mainContexts = () => bodies.filter((b) => b.tools?.length).map((b) => String(b.messages.at(-1).content));
  const systems = () => bodies.filter((b) => b.tools?.length).map((b) => String(b.messages[0].content));
  return { agent, db, bodies, sent, say, cfg, mainContexts, systems, tick: (ms: number) => (now += ms) };
}

/** 两个字符串从头开始相同的长度 */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

test("同一个会话连着聊:后一次请求以前一次的『记忆+摘要+聊天块』原样开头(缓存能命中)", async () => {
  const t = setup();
  t.db.addMemory("global", "她喜欢喝茶");
  for (const m of ["一", "二", "三", "四"]) await t.say("p:7", 7, m);
  const ctx = t.mainContexts();
  expect(ctx).toHaveLength(4);
  for (let n = 1; n < ctx.length; n++) {
    const before = ctx[n - 1]!;
    const stable = before.slice(0, before.indexOf("\n\n## 现在")); // 前一次在『现在』之前的全部内容
    expect(ctx[n]!.startsWith(stable)).toBe(true);
    if (n >= 2) expect(stable.length).toBeGreaterThan(60); // 有了会话块,前面这一大段都是命中的部分
  }
  // 系统提示词每次都逐字相同
  expect(new Set(t.systems()).size).toBe(1);
});

test("切换会话:正在处理的会话块排在最后,没动静的排前面,前面不变的部分仍然相同", async () => {
  const t = setup();
  await t.say("p:7", 7, "甲一");
  await t.say("p:8", 8, "乙一");
  await t.say("p:8", 8, "乙二"); // 继续聊乙:前缀应当命中
  await t.say("p:7", 7, "甲二"); // 切回甲
  const ctx = t.mainContexts();
  // 乙继续:第三次请求以第二次的块原样开头
  expect(ctx[2]!.startsWith(ctx[1]!.slice(0, ctx[1]!.indexOf("\n\n## 现在")))).toBe(true);
  // 切回甲:甲排到最后
  const last = ctx[3]!;
  expect(last.indexOf("p:8】")).toBeLessThan(last.indexOf("p:7】"));
  expect(last).toContain("乙二"); // 另一个会话的内容仍然在上下文里
  // 开头的固定部分(到第一个会话块之前)不受影响
  expect(commonPrefix(ctx[2]!, last)).toBeGreaterThanOrEqual("## 各会话最近的聊天\n\n".length);
});

test("别的会话来了新消息:先放在『其他会话还没处理』里,不改它们的块;攒够 50 条才并进去", async () => {
  const t = setup({ judge: false });
  await t.say("p:7", 7, "私聊一");
  const g = (n: number, user = 21) => t.say("g:5", user, `群消息${n}`, "小明");
  await g(1);
  await g(2); // 判定为不插嘴,消息留在未处理里
  await t.say("p:7", 7, "私聊二");
  let ctx = t.mainContexts().at(-1)!;
  expect(ctx).toContain("## 其他会话里还没处理的新消息");
  expect(ctx).toContain("群消息2");
  expect(ctx).not.toContain("## 各会话最近的聊天\n\n【群");
  expect(ctx).not.toMatch(/【群「球友群」 g:5】\n── [\d-]+ ──\n[\d:]+ 小明\(21\): 群消息1\n[\s\S]*## 其他会话/);

  for (let i = 3; i <= 52; i++) t.db.addMessage({ space: "g:5", msgId: 1000 + i, ts: BASE + i, senderId: 21, senderName: "小明", role: "user", text: `群消息${i}` });
  await t.say("p:7", 7, "私聊三");
  ctx = t.mainContexts().at(-1)!;
  expect(ctx).not.toContain("## 其他会话里还没处理的新消息");
  expect(ctx).toContain("【群「球友群」 g:5】"); // 已并进自己的块
  expect(ctx.indexOf("g:5】")).toBeLessThan(ctx.indexOf("p:7】")); // 正在处理的私聊仍然排最后
});

test("近期消息涨满就整理最老的一批进摘要,之后在区间内只追加", async () => {
  const t = setup({ cfg: { memory: { maxMessages: 40, compactMessages: 20 } }, summarize: "旧事摘要" });
  for (let i = 1; i <= 30; i++) await t.say("p:7", 7, `话${i}`); // 每轮 2 条(她的回复),很快涨满
  const ctx = t.mainContexts();
  const summarized = ctx.findIndex((c) => c.includes("## 各会话更早的内容摘要"));
  expect(summarized).toBeGreaterThan(0);
  expect(t.db.getSpace("p:7").summary).toBe("旧事摘要");
  expect(t.db.includedCount("p:7")).toBeLessThan(40);
  expect(t.db.includedCount("p:7")).toBeGreaterThanOrEqual(20);
  // 整理之后紧接着的两次请求,聊天块的开头不变
  const after = ctx.slice(summarized + 1, summarized + 3);
  if (after.length === 2) {
    const block = (c: string) => c.slice(c.indexOf("## 各会话最近的聊天"), c.indexOf("\n\n## 现在")).split("\n").slice(0, 8).join("\n");
    expect(block(after[1]!)).toBe(block(after[0]!));
  }
});

test("长期记忆太长时整理合并:旧的归档,换成更短的新版", async () => {
  const entries = JSON.stringify([{ subject: "user:7", content: "7 喜欢猫,是程序员" }]);
  const t = setup({ cfg: { memory: { maxMemoryChars: 120 } }, consolidate: entries });
  for (let i = 0; i < 6; i++) t.db.addMemory("user:7", `第${i}条:7 喜欢猫,是程序员,住在上海,每天早上喝咖啡。`);
  expect(t.db.memoryChars()).toBeGreaterThan(120);
  await t.say("p:7", 7, "你好");
  expect(t.db.allMemories().map((m) => m.content)).toEqual(["7 喜欢猫,是程序员"]);
  const archived = t.db.raw.query("SELECT COUNT(*) AS n FROM memories_archive").get() as { n: number };
  expect(archived.n).toBe(6);
});

test("整理结果没变短或格式不对时不替换", async () => {
  expect(parseConsolidation("没有 JSON")).toBeNull();
  expect(parseConsolidation('[{"subject":"乱写","content":"x"}]')).toBeNull();
  expect(parseConsolidation('前言 [{"subject":"global","content":"x"}] 后记')).toEqual([{ subject: "global", content: "x" }]);
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      const longer = JSON.stringify([{ subject: "global", content: "很长很长".repeat(100) }]);
      return Response.json({ choices: [{ message: { role: "assistant", content: longer } }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const db = new Db(":memory:");
  db.addMemory("global", "短短一句话,但是上限设得很低所以会触发整理");
  const llm = new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 }));
  expect(await consolidateMemories(db, llm, "m", 10)).toBe(false);
  expect(db.allMemories()).toHaveLength(1);
});

test("旧数据库升级:已处理的消息保留顺序,没处理的仍待处理,摘要位置换算过来", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqa-mig-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent.db");
  const old = new Database(path);
  old.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, msg_id INTEGER, ts INTEGER NOT NULL, sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE spaces (space TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', summarized_upto INTEGER NOT NULL DEFAULT 0, llm_cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, first_row INTEGER NOT NULL, last_row INTEGER NOT NULL, ts INTEGER NOT NULL, messages TEXT NOT NULL);
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
    INSERT INTO messages (space, msg_id, ts, sender_id, sender_name, role, text) VALUES
      ('p:7', 1, 1, 7, 'a', 'user', '旧一'), ('p:7', 2, 2, 100, '我', 'self', '旧回'), ('p:7', 3, 3, 7, 'a', 'user', '旧二'), ('p:7', 4, 4, 7, 'a', 'user', '还没处理');
    INSERT INTO spaces (space, title, summary, summarized_upto, llm_cursor) VALUES ('p:7', '甲', '以前聊过猫', 1, 3);
    INSERT INTO memories (subject, content, ts) VALUES ('global', '记忆还在', 1);
  `);
  old.close();

  const db = new Db(path);
  expect((db.raw.query("PRAGMA user_version").get() as any).user_version).toBe(2);
  expect(db.included("p:7").map((m) => m.text)).toEqual(["旧回", "旧二"]); // 第 1 条已被摘要覆盖
  expect(db.unseen("p:7").map((m) => m.text)).toEqual(["还没处理"]);
  expect(db.getSpace("p:7").summary).toBe("以前聊过猫");
  expect(db.allMemories().map((m) => m.content)).toEqual(["记忆还在"]);
  db.close();
  expect(new Db(path).raw).toBeTruthy(); // 重复打开不会重复迁移或报错
});

test("消息行格式:紧凑,QQ 号只在第一次出现时带,重名每次都带,@我,换行折叠,跨天加日期", () => {
  const m = (id: number, ts: number, senderId: number, senderName: string, text: string, role: "user" | "self" = "user"): StoredMessage => ({
    id,
    space: "p:1",
    msgId: id,
    ts,
    senderId,
    senderName,
    role,
    text,
  });
  const day = 86_400;
  const lines = formatLines(
    [
      m(1, BASE, 1, "小明", "早"),
      m(2, BASE + 60, 1, "小明", "在吗 @100"),
      m(3, BASE + 120, 100, "我", "在的", "self"),
      m(4, BASE + day, 2, "小红", "第一行\n第二行"),
    ],
    { selfId: 100 },
  );
  expect(lines.filter((l) => l.startsWith("──"))).toHaveLength(2);
  const body = lines.filter((l) => !l.startsWith("──"));
  expect(body[0]).toMatch(/^\d\d:\d\d 小明\(1\): 早$/);
  expect(body[1]).toMatch(/^\d\d:\d\d 小明: 在吗 @我$/);
  expect(body[2]).toMatch(/^\d\d:\d\d 我: 在的$/);
  expect(body[3]).toMatch(/^\d\d:\d\d 小红\(2\): 第一行 ⏎ 第二行$/);

  const dup = formatLines([m(1, BASE, 1, "阿强", "a"), m(2, BASE + 1, 2, "阿强", "b"), m(3, BASE + 2, 1, "阿强", "c")]);
  expect(dup.filter((l) => !l.startsWith("──")).map((l) => l.replace(/^\d\d:\d\d /, ""))).toEqual(["阿强(1): a", "阿强(2): b", "阿强(1): c"]);

  expect(formatLines([m(1, BASE, 1, "小明", "早")], { withIds: true })[1]).toMatch(/^\d\d:\d\d #1 小明\(1\): 早$/);
});
