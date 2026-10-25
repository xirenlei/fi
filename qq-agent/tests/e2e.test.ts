import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { defaultConfig, mergeConfig } from "../src/config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  delete process.env.QQ_AGENT_HOME;
});

test("端到端:NapCat 推来私聊消息 → 模型回复 → 通过 NapCat 发出", async () => {
  const home = mkdtempSync(join(tmpdir(), "qqa-e2e-"));
  process.env.QQ_AGENT_HOME = home;
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  const received: Array<{ action: string; params: any }> = [];
  let socket: any;
  const napcat = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const token = new URL(req.url).searchParams.get("access_token");
      if (token !== "tok") return new Response("unauthorized", { status: 401 });
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open: (ws) => void (socket = ws),
      message(ws, raw) {
        const req = JSON.parse(String(raw));
        received.push({ action: req.action, params: req.params });
        const data = req.action === "get_login_info" ? { user_id: 100, nickname: "bot" } : { message_id: 9000 + received.length };
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: req.echo }));
      },
    },
  });
  cleanups.push(() => napcat.stop(true));

  const llm = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      const asked = JSON.stringify(body.messages);
      const content = asked.includes("在吗") ? "<msg>在的</msg><msg>什么事</msg>" : "<silent/>";
      return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => llm.stop(true));

  const cfg = mergeConfig(defaultConfig, {
    napcat: { wsUrl: `ws://127.0.0.1:${napcat.port}`, token: "tok" },
    llm: { baseUrl: `http://127.0.0.1:${llm.port}`, apiKey: "k" },
    behavior: { typingMsPerChar: 0 },
    opencode: { workdir: join(home, "ws") },
  });
  const app = createApp(cfg);
  cleanups.push(() => void app.stop());
  await app.start();
  await app.napcat.waitOpen();
  await app.napcat.getLoginInfo();

  socket.send(
    JSON.stringify({ post_type: "message", message_type: "private", message_id: 1, user_id: 7, self_id: 100, time: 1700000000, message: [{ type: "text", data: { text: "在吗" } }], sender: { nickname: "小七" } }),
  );
  const until = Date.now() + 3000;
  while (received.filter((r) => r.action === "send_private_msg").length < 2 && Date.now() < until) await Bun.sleep(20);
  await app.agent.idle();

  const sends = received.filter((r) => r.action === "send_private_msg");
  expect(sends.map((s) => s.params.message[0].data.text)).toEqual(["在的", "什么事"]);
  expect(sends[0]!.params.user_id).toBe(7);
  expect(app.db.recent("p:7", 10).map((m) => m.text)).toEqual(["在吗", "在的", "什么事"]);
});
