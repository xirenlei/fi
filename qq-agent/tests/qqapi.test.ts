import { afterEach, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { interpretEvent } from "../src/agent/events";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig } from "../src/config";
import { LlmClient } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { loadCatalog, searchCatalog } from "../src/napcat/catalog";
import { parseMessage } from "../src/napcat/parse";
import type { OneBotEvent, Segment, SpaceId } from "../src/napcat/types";
import { qqApiTools } from "../src/tools/qqapi";
import { buildCatalog } from "../scripts/gen-napcat-catalog";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const ctx = { space: "g:1", triggerSenderIds: [] };

test("目录:包含全部接口,能按关键词找到,且不暴露凭证类接口", async () => {
  const cat = loadCatalog();
  expect(cat.length).toBeGreaterThan(150);
  expect(searchCatalog(cat, "禁言").map((e) => e.action)).toContain("set_group_ban");
  expect(searchCatalog(cat, "合并转发").map((e) => e.action)).toContain("get_forward_msg");
  const reg = new ToolRegistry(qqApiTools({ call: async () => null }));
  const out = await reg.run("qq_api_search", '{"query":"cookies 凭证"}', ctx);
  expect(out).not.toContain("get_cookies");
  expect(await reg.run("qq_api_search", "{}", ctx)).toContain("个接口");
  expect(await reg.run("qq_api_search", '{"tag":"AI"}', ctx)).toContain("send_group_ai_record");
});

test("目录生成器能从源码里抽出动作、参数和必填信息", () => {
  const src = `
    const re = { DoThing: "do_thing" };
    const Pay = p.Object({
      group_id: p.String({ description: "群号" }),
      times: p.Optional(p.Number({ description: "次数" })),
      mode: p.String({ default: "a", description: "模式" })
    });
    class X extends ue {
      actionName = re.DoThing;
      actionSummary = "做件事";
      actionDescription = "详细说明";
      actionTags = ["扩展接口"];
      payloadSchema = Pay;
    }`;
  expect(buildCatalog(src)).toEqual([
    {
      action: "do_thing",
      summary: "做件事",
      description: "详细说明",
      tags: ["扩展接口"],
      params: [
        { name: "group_id", type: "string", required: true, description: "群号" },
        { name: "times", type: "number", required: false, description: "次数" },
        { name: "mode", type: "string", required: false, description: "模式" },
      ],
    },
  ]);
});

test("qq_api:校验必填参数、拒绝危险接口、长结果截断", async () => {
  const calls: Array<[string, any]> = [];
  const reg = new ToolRegistry(
    qqApiTools({
      async call(action, params) {
        calls.push([action, params]);
        return action === "big" ? Array.from({ length: 2000 }, (_, i) => ({ i })) : { ok: true };
      },
    }),
  );
  expect(await reg.run("qq_api", '{"action":"set_group_ban","params":{}}', ctx)).toContain("缺少必填参数: group_id");
  expect(calls).toHaveLength(0);
  expect(await reg.run("qq_api", '{"action":"set_group_ban","params":{"group_id":"1","user_id":"2","duration":60}}', ctx)).toContain('"ok": true');
  expect(calls[0]).toEqual(["set_group_ban", { group_id: "1", user_id: "2", duration: 60 }]);
  expect(await reg.run("qq_api", '{"action":"get_cookies"}', ctx)).toContain("不对你开放");
  expect(await reg.run("qq_api", '{"action":"bot_exit"}', ctx)).toContain("不对你开放");
  expect(await reg.run("qq_api", '{"action":"bad action!"}', ctx)).toContain("不合法");
  const big = await reg.run("qq_api", '{"action":"big"}', ctx);
  expect(big).toContain("已截断(共 2000 项)");
  expect(big.length).toBeLessThan(6300);
});

test("群概览与用户资料:整理成可读文字", async () => {
  const members = [
    { user_id: 1, nickname: "群主", card: "", role: "owner", last_sent_time: 1700000000 },
    { user_id: 2, nickname: "小明", card: "明哥", role: "member", last_sent_time: 1700001000, title: "龙王" },
  ];
  const reg = new ToolRegistry(
    qqApiTools({
      async call(action) {
        if (action === "get_group_info") return { group_name: "摸鱼群", member_count: 2, max_member_count: 200 };
        if (action === "get_group_member_list") return members;
        if (action === "get_stranger_info") return { user_id: 2, nickname: "小明", sex: "male", age: 25, long_nick: "今天也要加油", empty: "", obj: { a: 1 } };
        if (action === "get_group_member_info") return members[1];
        return null;
      },
    }),
  );
  const g = await reg.run("group_overview", '{"group_id":100}', ctx);
  expect(g).toContain("群「摸鱼群」(100) 成员 2/200");
  expect(g).toContain("明哥(小明) [成员] 头衔:龙王");
  expect(g).toContain("[群主]");
  const u = await reg.run("user_profile", '{"user_id":2,"group_id":100}', ctx);
  expect(u).toContain("long_nick: 今天也要加油");
  expect(u).not.toContain("empty");
  expect(u).not.toContain("obj");
  expect(u).toContain("在群 100 的信息");
});

test("人多的群只列管理员和最近活跃的人", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ user_id: i + 10, nickname: `n${i}`, card: "", role: i === 0 ? "admin" : "member", last_sent_time: i }));
  const reg = new ToolRegistry(qqApiTools({ call: async (a) => (a === "get_group_info" ? { group_name: "大群", member_count: 120, max_member_count: 500 } : many) }));
  const out = await reg.run("group_overview", '{"group_id":1}', ctx);
  expect(out).toContain("人数较多");
  expect(out.split("\n").length).toBeLessThan(45);
  expect(out).toContain("n119"); // 最近发言的人
});

test("事件翻译:好友请求、入群邀请、被戳、进退群", () => {
  const friend = interpretEvent({ post_type: "request", request_type: "friend", user_id: 5, comment: "我是小五", flag: "F1" } as OneBotEvent, 100, [5]);
  expect(friend).toMatchObject({ type: "request", kind: "friend", flag: "F1", fromAdmin: true });
  expect((friend as any).text).toContain("我是小五");
  expect((friend as any).reject()).toEqual({ action: "set_friend_add_request", params: { flag: "F1", approve: false } });

  const invite = interpretEvent({ post_type: "request", request_type: "group", sub_type: "invite", group_id: 9, user_id: 7, flag: "G1" } as OneBotEvent, 100, []);
  expect((invite as any).text).toContain("邀请你加入群 9");
  expect((invite as any).reject().action).toBe("set_group_add_request");

  expect(interpretEvent({ post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 7, target_id: 100, group_id: 9 } as OneBotEvent, 100, [])).toMatchObject({ type: "note", space: "g:9", trigger: "mention" });
  expect(interpretEvent({ post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 7, target_id: 555 } as OneBotEvent, 100, [])).toBeNull();
  expect(interpretEvent({ post_type: "notice", notice_type: "group_increase", group_id: 9, user_id: 100, sub_type: "invite" } as OneBotEvent, 100, [])).toMatchObject({ type: "wander" });
  expect(interpretEvent({ post_type: "notice", notice_type: "group_increase", group_id: 9, user_id: 8 } as OneBotEvent, 100, [])).toMatchObject({ type: "note", trigger: "judge" });
  expect(interpretEvent({ post_type: "notice", notice_type: "group_decrease", group_id: 9, user_id: 8, sub_type: "kick" } as OneBotEvent, 100, [])).toMatchObject({ trigger: "none" });
  expect(interpretEvent({ post_type: "notice", notice_type: "friend_add", user_id: 8 } as OneBotEvent, 100, [])).toMatchObject({ type: "wander" });
  expect(interpretEvent({ post_type: "meta_event" } as OneBotEvent, 100, [])).toBeNull();
});

test("消息解析:合并转发、语音、文件、卡片的占位符带着 id", () => {
  const p = parseMessage({
    self_id: 1,
    message: [
      { type: "forward", data: { id: "FW123" } },
      { type: "record", data: { file: "voice.amr" } },
      { type: "file", data: { file: "FILEID", name: "报告.pdf" } },
      { type: "json", data: { data: JSON.stringify({ prompt: "[分享]一篇文章", app: "x" }) } },
    ],
  } as any);
  expect(p.text).toBe("[合并转发 id=FW123][语音 file=voice.amr][文件:报告.pdf file=FILEID][卡片:[分享]一篇文章]");
});

function setup(cfgPatch: object = {}) {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return Response.json({ choices: [{ message: { role: "assistant", content: "<silent/>" }, finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const db = new Db(":memory:");
  const calls: Array<[string, any]> = [];
  const napcat = {
    selfId: 100,
    async send(_s: SpaceId, _m: Segment[]) {
      return 1;
    },
    async call<T>(action: string, params?: any): Promise<T> {
      calls.push([action, params]);
      return {} as T;
    },
  };
  const cfg = mergeConfig(defaultConfig, { admins: [5], ...cfgPatch });
  const agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm: new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 })),
    tools: new ToolRegistry([...memoryTools(db), ...qqApiTools({ call: (a, p) => napcat.call(a, p) })]),
    sleep: async () => {},
    log: () => {},
  });
  return { agent, db, bodies, calls };
}

const friendReq = (user: number): OneBotEvent => ({ post_type: "request", request_type: "friend", user_id: user, comment: "你好", flag: "FLAG1", self_id: 100 }) as OneBotEvent;

async function settle(agent: Agent, bodies: any[], n: number) {
  for (let i = 0; i < 300 && bodies.length < n; i++) await Bun.sleep(10);
  await agent.idle();
  await Bun.sleep(30);
}

test("收到好友请求:唤醒模型,附带 flag 和处理指引;管理员发起的会注明", async () => {
  const t = setup();
  await t.agent.handleEvent(friendReq(5));
  await settle(t.agent, t.bodies, 1);
  const last = JSON.stringify(t.bodies[0].messages.at(-1));
  expect(last).toContain("好友请求");
  expect(last).toContain("FLAG1");
  expect(last).toContain("发起人是管理员");
  expect(t.bodies[0].tools.map((x: any) => x.function.name)).toEqual(expect.arrayContaining(["handle_friend_request", "qq_api"]));
});

test("请求处理方式设为拒绝:不经过模型,直接拒绝", async () => {
  const t = setup({ requests: { mode: "reject" } });
  await t.agent.handleEvent(friendReq(9));
  expect(t.bodies).toHaveLength(0);
  expect(t.calls).toEqual([["set_friend_add_request", { flag: "FLAG1", approve: false }]]);
});

test("请求处理方式设为只通知:提示模型不要自己处理", async () => {
  const t = setup({ requests: { mode: "notify" } });
  await t.agent.handleEvent(friendReq(9));
  await settle(t.agent, t.bodies, 1);
  expect(JSON.stringify(t.bodies[0].messages.at(-1))).toContain("不要自己同意或拒绝");
});

test("同时来两个事件:第二个排队,不会丢", async () => {
  const t = setup();
  await t.agent.handleEvent(friendReq(11));
  await t.agent.handleEvent({ ...friendReq(12), flag: "FLAG2" });
  await settle(t.agent, t.bodies, 2);
  const all = JSON.stringify(t.bodies);
  expect(all).toContain("QQ 11");
  expect(all).toContain("QQ 12");
});

test("被戳一下:在对应会话里记一笔并触发回复", async () => {
  const t = setup();
  await t.agent.handleEvent({ post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 7, target_id: 100, self_id: 100 } as OneBotEvent);
  await settle(t.agent, t.bodies, 1);
  expect(JSON.stringify(t.bodies[0].messages.at(-1))).toContain("戳了你一下");
  expect(t.db.recent("p:7", 5)[0]!.text).toContain("戳了你一下");
});
