import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { defaultConfig, mergeConfig } from "../src/config";
import { applyConfig, maskConfig, startWeb } from "../src/web/server";

let home: string;
let app: App;
let server: ReturnType<typeof startWeb>;
let base: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qqa-web-"));
  process.env.QQ_AGENT_HOME = home;
  const cfg = mergeConfig(defaultConfig, { opencode: { workdir: join(home, "ws"), baseUrl: "http://127.0.0.1:1", autoStart: false }, llm: { apiKey: "sk-secret" } });
  app = createApp(cfg);
  server = startWeb(app, 0);
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  app.db.close();
  rmSync(home, { recursive: true, force: true });
  delete process.env.QQ_AGENT_HOME;
});

const H = { "content-type": "application/json", "x-qq-agent": "1" };

describe("config helpers", () => {
  test("密钥被遮蔽,提交 *** 时保持原值", () => {
    const cfg = mergeConfig(defaultConfig, { llm: { apiKey: "sk-1" } });
    expect(maskConfig(cfg).llm.apiKey).toBe("***");
    expect(maskConfig(defaultConfig).llm.apiKey).toBe("");
    applyConfig(cfg, { llm: { apiKey: "***", model: "m2" } });
    expect(cfg.llm.apiKey).toBe("sk-1");
    expect(cfg.llm.model).toBe("m2");
    applyConfig(cfg, { llm: { apiKey: "sk-2" } });
    expect(cfg.llm.apiKey).toBe("sk-2");
  });
  test("非法值被拒绝", () => {
    const cfg = structuredClone(defaultConfig);
    expect(() => applyConfig(cfg, { admins: ["abc"] })).toThrow();
    expect(() => applyConfig(cfg, { memory: { maxMessages: 10 } })).toThrow();
  });
});

describe("web api", () => {
  test("首页和状态", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain("QQ Agent 控制台");
    const st = await (await fetch(base + "/api/status")).json();
    expect(st.napcat.connected).toBe(false);
    expect(st.opencode.healthy).toBe(false);
  });

  test("保存配置:立即生效,落盘,密钥不回显", async () => {
    const r = await fetch(base + "/api/config", { method: "PUT", headers: H, body: JSON.stringify({ llm: { model: "deepseek-x", apiKey: "***" }, admins: [123] }) });
    expect((await r.json()).ok).toBe(true);
    expect(app.cfg.llm.model).toBe("deepseek-x");
    expect(app.cfg.llm.apiKey).toBe("sk-secret");
    expect(app.cfg.admins).toEqual([123]);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.llm.model).toBe("deepseek-x");
    const got = await (await fetch(base + "/api/config")).json();
    expect(got.llm.apiKey).toBe("***");
  });

  test("修改 NapCat 地址会提示需要重启", async () => {
    const r = await fetch(base + "/api/config", { method: "PUT", headers: H, body: JSON.stringify({ napcat: { wsUrl: "ws://127.0.0.1:9999" } }) });
    expect((await r.json()).restartRequired).toBe(true);
  });

  test("写操作需要自定义头,Host 必须是本机", async () => {
    const r = await fetch(base + "/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
    const r2 = await fetch(base + "/api/status", { headers: { host: "evil.example.com" } });
    expect(r2.status).toBe(403);
  });

  test("记忆、会话、图库和任务接口", async () => {
    const add = await fetch(base + "/api/memories", { method: "POST", headers: H, body: JSON.stringify({ subject: "user:5", content: "喜欢猫" }) });
    const { id } = await add.json();
    expect((await (await fetch(base + "/api/memories")).json()).map((m: any) => m.content)).toEqual(["喜欢猫"]);
    expect((await fetch(base + "/api/memories", { method: "POST", headers: H, body: JSON.stringify({ subject: "bad", content: "x" }) })).status).toBe(400);
    expect((await (await fetch(`${base}/api/memories/${id}`, { method: "DELETE", headers: H })).json()).ok).toBe(true);

    app.db.addMessage({ space: "p:5", msgId: 1, ts: 1, senderId: 5, senderName: "小五", role: "user", text: "你好" });
    expect((await (await fetch(base + "/api/spaces")).json())[0].messages).toBe(1);
    expect((await (await fetch(base + "/api/spaces/p:5")).json()).messages[0].text).toBe("你好");

    const item = app.store.add({ kind: "sticker", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), ext: "png", mime: "image/png", summary: "开心" });
    expect((await (await fetch(base + "/api/media?q=开心")).json())[0].id).toBe(item.id);
    expect((await (await fetch(base + "/api/media?kind=&q=")).json())).toHaveLength(1); // 前端默认传空的 kind
    const file = await fetch(`${base}/api/media/${item.id}/file`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect((await file.arrayBuffer()).byteLength).toBe(7);
    expect((await (await fetch(`${base}/api/media/${item.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ kind: "image" }) })).json()).kind).toBe("image");
    expect((await (await fetch(`${base}/api/media/${item.id}`, { method: "DELETE", headers: H })).json()).ok).toBe(true);

    expect(await (await fetch(base + "/api/tasks")).json()).toEqual([]);
    expect((await fetch(base + "/api/logs/bogus")).status).toBe(404);
  });
});

describe("版本更新", () => {
  test("读取 install.env;没有仓库时说明不支持自动更新", async () => {
    const { readInstallEnv, checkUpdate } = await import("../src/web/server");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "install.env"), "APP_DIR='/nowhere'\nBRANCH='main'\n");
    expect(readInstallEnv()).toEqual({ APP_DIR: "/nowhere", BRANCH: "main" });
    const info = await checkUpdate();
    expect(info.supported).toBe(false);
    const api = await (await fetch(base + "/api/update/check")).json();
    expect(api.supported).toBe(false);
    expect(await (await fetch(base + "/api/update/log")).json()).toMatchObject({ running: false });
  });

  test("有仓库时能比较出落后几个提交,并列出提交说明", async () => {
    const { checkUpdate } = await import("../src/web/server");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const sh = async (cmd: string, cwd: string) => {
      const p = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
      await p.exited;
    };
    const remote = join(home, "remote.git");
    const work = join(home, "work");
    const app = join(home, "appdir");
    mkdirSync(app, { recursive: true });
    const git = "git -c user.name=t -c user.email=t@t -c commit.gpgsign=false";
    await sh(`git init -q --bare -b main '${remote}' && git clone -q '${remote}' '${work}'`, home);
    await sh(`echo 1 > a && git add a && ${git} commit -qm "第一版" && git push -q origin HEAD:main`, work);
    await sh(`git clone -q '${remote}' '${join(app, "repo")}'`, home);
    writeFileSync(join(home, "install.env"), `APP_DIR='${app}'\nBRANCH='main'\n`);
    const same = await checkUpdate();
    expect(same.supported).toBe(true);
    expect(same.behind).toBe(0);
    expect(same.current?.subject).toBe("第一版");
    await sh(`echo 2 > a && ${git} commit -qam "修复了一个问题" && echo 3 > a && ${git} commit -qam "新增一个功能" && git push -q origin HEAD:main`, work);
    const behind = await checkUpdate();
    expect(behind.behind).toBe(2);
    expect(behind.commits?.join("\n")).toContain("新增一个功能");
  });
});
