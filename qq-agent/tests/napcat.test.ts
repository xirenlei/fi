import { afterEach, describe, expect, test } from "bun:test";
import { Db } from "../src/memory/db";
import { NapcatClient, isMessageEvent } from "../src/napcat/client";
import { parseMessage, seg } from "../src/napcat/parse";
import { parseSpace, spaceOf, type MessageEvent } from "../src/napcat/types";
import { mergeConfig, defaultConfig } from "../src/config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** 起一个假的 NapCat:记录收到的动作,按动作名回复 */
function mockNapcat(onAction: (action: string, params: any) => any) {
  const sockets = new Set<any>();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws, raw) {
        const req = JSON.parse(String(raw));
        const data = onAction(req.action, req.params);
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: req.echo }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `ws://127.0.0.1:${server.port}`,
    push: (ev: unknown) => sockets.forEach((s) => s.send(JSON.stringify(ev))),
  };
}

describe("parseMessage", () => {
  test("文本、@、回复和媒体占位", () => {
    const p = parseMessage({
      self_id: 100,
      message: [
        { type: "reply", data: { id: "55" } },
        seg.at(100),
        seg.text(" 看这个"),
        { type: "image", data: { url: "http://x/a.png", sub_type: 1 } },
        { type: "image", data: { url: "http://x/b.png", sub_type: 0 } },
        { type: "video", data: { url: "http://x/v.mp4" } },
      ],
    });
    expect(p.text).toBe("@100 看这个[表情包][图片][视频]");
    expect(p.mentionsSelf).toBe(true);
    expect(p.replyToId).toBe(55);
    expect(p.media.map((m) => m.kind)).toEqual(["image", "image", "video"]);
    expect(p.media[0]!.isSticker).toBe(true);
    expect(p.media[1]!.isSticker).toBe(false);
  });

  test("@别人不算 @ 自己", () => {
    const p = parseMessage({ self_id: 100, message: [seg.at(200), seg.text("hi")] });
    expect(p.mentionsSelf).toBe(false);
  });
});

describe("space", () => {
  test("群和私聊分别映射", () => {
    expect(spaceOf({ message_type: "group", group_id: 9, user_id: 1 })).toBe("g:9");
    expect(spaceOf({ message_type: "private", user_id: 1 })).toBe("p:1");
    expect(parseSpace("g:9")).toEqual({ type: "group", id: 9 });
    expect(() => parseSpace("x:1")).toThrow();
  });
});

describe("NapcatClient", () => {
  test("收到事件并能调用动作", async () => {
    const actions: Array<[string, any]> = [];
    const mock = mockNapcat((action, params) => {
      actions.push([action, params]);
      return action === "get_login_info" ? { user_id: 100, nickname: "bot" } : { message_id: 777 };
    });
    const client = new NapcatClient({ wsUrl: mock.url, log: () => {} });
    cleanups.push(() => client.close());
    const events: MessageEvent[] = [];
    client.onEvent((ev) => {
      if (isMessageEvent(ev)) events.push(ev);
    });
    client.connect();
    await client.waitOpen();

    const me = await client.getLoginInfo();
    expect(me.user_id).toBe(100);

    const id = await client.send("g:42", [seg.text("你好")]);
    expect(id).toBe(777);
    expect(actions.at(-1)).toEqual(["send_group_msg", { group_id: 42, message: [seg.text("你好")] }]);

    await client.send("p:7", [seg.text("私聊")]);
    expect(actions.at(-1)![0]).toBe("send_private_msg");

    mock.push({
      post_type: "message",
      message_type: "private",
      message_id: 1,
      user_id: 7,
      self_id: 100,
      time: 1,
      message: [seg.text("嗨")],
    });
    for (let i = 0; i < 200 && events.length < 1; i++) await Bun.sleep(10);
    expect(events).toHaveLength(1);
    expect(events[0]!.user_id).toBe(7);
  });

  test("动作失败时抛错", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws, raw) {
          const req = JSON.parse(String(raw));
          ws.send(JSON.stringify({ status: "failed", retcode: 1200, message: "boom", data: null, echo: req.echo }));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const client = new NapcatClient({ wsUrl: `ws://127.0.0.1:${server.port}`, log: () => {} });
    cleanups.push(() => client.close());
    client.connect();
    await client.waitOpen();
    await expect(client.call("send_group_msg", {})).rejects.toThrow(/retcode=1200/);
  });
});

describe("Db", () => {
  test("消息去重并按序返回最近 N 条", () => {
    const db = new Db(":memory:");
    const base = { space: "g:1", senderId: 1, senderName: "a", role: "user" as const };
    for (let i = 1; i <= 5; i++) db.addMessage({ ...base, msgId: i, ts: i, text: `m${i}` });
    expect(db.addMessage({ ...base, msgId: 3, ts: 3, text: "dup" })).toBe(false);
    expect(db.count("g:1")).toBe(5);
    expect(db.recent("g:1", 3).map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    expect(db.listSpaces()).toEqual(["g:1"]);
  });
});

describe("config", () => {
  test("深合并只覆盖给出的字段", () => {
    const merged = mergeConfig(defaultConfig, { llm: { apiKey: "k", thinking: { effort: "high" } } });
    expect(merged.llm.apiKey).toBe("k");
    expect(merged.llm.thinking.effort).toBe("high");
    expect(merged.llm.thinking.enabled).toBe(true);
    expect(merged.llm.baseUrl).toBe(defaultConfig.llm.baseUrl);
  });
});
