import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig } from "../src/config";
import { LlmClient } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { collectResult } from "../src/opencode/client";
import { OpenCodeManager, type TaskDone } from "../src/opencode/manager";
import { TaskStore } from "../src/opencode/tasks";
import { openCodeTools } from "../src/opencode/tools";
import { runShell, systemTools } from "../src/tools/system";
import type { Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** 按真实 OpenCode 1.19 的接口形状做的假服务 */
function mockOpenCode(opts: { failWith?: string; delayMs?: number } = {}) {
  const streams = new Set<ReadableStreamDefaultController>();
  const sessions = new Map<string, any[]>();
  const calls: string[] = [];
  const emit = (type: string, properties: any) => {
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ id: "e", type, properties })}\n\n`);
    for (const c of streams) c.enqueue(chunk);
  };
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}?directory=${u.searchParams.get("directory")}`);
      if (u.pathname === "/global/health") return Response.json({ healthy: true });
      if (u.pathname === "/event") {
        return new Response(
          new ReadableStream({
            start(c) {
              streams.add(c);
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`));
            },
            cancel() {},
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (u.pathname === "/session" && req.method === "POST") {
        const id = `ses_${++n}`;
        sessions.set(id, []);
        return Response.json({ id });
      }
      const m = u.pathname.match(/^\/session\/([^/]+)\/(prompt_async|message|abort)$/);
      if (m) {
        const [, id, what] = m as unknown as [string, string, string];
        const msgs = sessions.get(id)!;
        if (what === "message") return Response.json(msgs);
        if (what === "abort") return new Response(null, { status: 200 });
        const body: any = await req.json();
        msgs.push({ info: { id: `u${msgs.length}`, role: "user", time: { created: 1 } }, parts: [{ type: "text", text: body.parts[0].text }] });
        setTimeout(() => {
          const info: any = { id: `a${msgs.length}`, role: "assistant", time: { created: 2, completed: 3 } };
          if (opts.failWith) info.error = { name: "APIError", data: { message: opts.failWith } };
          msgs.push({ info, parts: opts.failWith ? [] : [{ type: "step-start" }, { type: "text", text: `完成:${body.parts[0].text}` }] });
          if (opts.failWith) emit("session.error", { sessionID: id });
          emit("session.idle", { sessionID: id });
        }, opts.delayMs ?? 30);
        return new Response(null, { status: 204 });
      }
      return new Response("nope", { status: 404 });
    },
  });
  cleanups.push(() => {
    for (const c of streams) try { c.close(); } catch {}
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, calls };
}

function makeManager(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "qqa-oc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(":memory:");
  const cfg = mergeConfig(defaultConfig, { opencode: { workdir: dir, baseUrl: url, autoStart: false }, admins: [1] });
  const mgr = new OpenCodeManager(() => cfg, new TaskStore(db), () => {});
  cleanups.push(() => void mgr.stop());
  return { mgr, db, cfg, dir };
}

describe("collectResult", () => {
  test("只取最后一条用户消息之后的助手文字", () => {
    const r = collectResult([
      { info: { id: "1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "旧" }] },
      { info: { id: "2", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "旧答案" }] },
      { info: { id: "3", role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "新" }] },
      { info: { id: "4", role: "assistant", time: { created: 3, completed: 4 } }, parts: [{ type: "tool" }, { type: "text", text: "新答案" }] },
    ]);
    expect(r).toEqual({ text: "新答案", error: undefined, completed: true });
  });
  test("未完成与出错", () => {
    const u = { info: { id: "1", role: "user" as const, time: { created: 1 } }, parts: [] };
    expect(collectResult([u, { info: { id: "2", role: "assistant", time: { created: 2 } }, parts: [] }]).completed).toBe(false);
    const e = collectResult([u, { info: { id: "2", role: "assistant", time: { created: 2 }, error: { name: "X", data: { message: "炸了" } } }, parts: [] }]);
    expect(e.error).toBe("炸了");
  });
});

describe("OpenCodeManager", () => {
  test("提交任务,完成事件到达后回调结果,请求都带 directory", async () => {
    const oc = mockOpenCode();
    const { mgr, dir } = makeManager(oc.url);
    const done: TaskDone[] = [];
    mgr.onDone = (d) => void done.push(d);
    const task = await mgr.submit("p:1", "写个脚本");
    await Bun.sleep(300);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("done");
    expect(done[0]!.result).toBe("完成:写个脚本");
    expect(mgr.tasks.get(task.id)!.status).toBe("done");
    expect(oc.calls.filter((c) => !c.includes("/global/health")).every((c) => c.endsWith(`directory=${dir}`))).toBe(true);
  });

  test("OpenCode 报错时任务标记为 error", async () => {
    const oc = mockOpenCode({ failWith: "没有可用的模型" });
    const { mgr } = makeManager(oc.url);
    const done: TaskDone[] = [];
    mgr.onDone = (d) => void done.push(d);
    await mgr.submit("p:1", "x");
    await Bun.sleep(300);
    expect(done[0]!.status).toBe("error");
    expect(done[0]!.result).toContain("没有可用的模型");
  });

  test("同一会话有任务在跑时拒绝再提交;可 abort", async () => {
    const oc = mockOpenCode({ delayMs: 5000 });
    const { mgr } = makeManager(oc.url);
    const t = await mgr.submit("p:1", "长任务");
    await expect(mgr.submit("p:1", "再来", t.sessionId)).rejects.toThrow(/还有任务/);
    expect(await mgr.abort(t.id)).toBe(true);
    expect(mgr.tasks.get(t.id)!.status).toBe("aborted");
  });

  test("重连后补查错过的完成事件", async () => {
    const oc = mockOpenCode({ delayMs: 10 });
    const { mgr } = makeManager(oc.url);
    const done: TaskDone[] = [];
    mgr.onDone = (d) => void done.push(d);
    // 不开启事件监听,直接提交后手动补查
    const task = mgr.tasks.create((await mgr.client.createSession("t")).id, "p:1", "补查");
    await mgr.client.promptAsync(task.sessionId, "补查");
    await Bun.sleep(100);
    await mgr.reconcile();
    expect(done).toHaveLength(1);
    expect(done[0]!.result).toBe("完成:补查");
  });
});

describe("工具权限", () => {
  test("工具不再有硬性权限限制,任何人触发都能用(靠提示词约束)", async () => {
    const oc = mockOpenCode();
    const { mgr, dir } = makeManager(oc.url);
    const reg = new ToolRegistry([...openCodeTools(mgr), ...systemTools(() => dir)]);
    const ctx = { space: "g:1", triggerSenderIds: [2] };
    expect(await reg.run("shell", '{"command":"echo hi && pwd"}', ctx)).toContain(`hi\n${dir}`);
    expect(await reg.run("opencode_run", '{"prompt":"x"}', ctx)).toContain("任务 #1");
  });

  test("shell 超时会被终止,输出过长会被截断", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqa-sh-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = await runShell("sleep 5", dir, 200);
    expect(r.timedOut).toBe(true);
    const reg = new ToolRegistry(systemTools(() => dir));
    const out = await reg.run("shell", JSON.stringify({ command: "head -c 30000 /dev/zero | tr '\\0' a" }), { space: "p:1", triggerSenderIds: [1] });
    expect(out).toContain("中间省略");
    expect(out.length).toBeLessThan(9000);
  });
});

describe("任务完成后由 Agent 汇报", () => {
  test("notify 触发模型,模型把结果转述给发起任务的聊天", async () => {
    const oc = mockOpenCode();
    const { mgr, db, cfg } = makeManager(oc.url);
    const llmBodies: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        llmBodies.push(body);
        return Response.json({ choices: [{ message: { role: "assistant", content: "<msg>搞定啦</msg><msg>脚本写好了</msg>" }, finish_reason: "stop" }] });
      },
    });
    cleanups.push(() => server.stop(true));
    const sent: Array<{ space: string; message: Segment[] }> = [];
    const agent = new Agent({
      cfg: () => mergeConfig(cfg, { behavior: { typingMsPerChar: 0 } }),
      db,
      napcat: {
        selfId: 100,
        async send(space: SpaceId, message: Segment[]) {
          sent.push({ space, message });
          return sent.length;
        },
        async call<T>() {
          return {} as T;
        },
      },
      llm: new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 })),
      tools: new ToolRegistry(memoryTools(db)),
      sleep: async () => {},
      log: () => {},
    });
    mgr.onDone = (d) => agent.notify(d.task.space, `[OpenCode 任务 #${d.task.id} 已完成]\n${d.result}`);
    await mgr.submit("g:9", "写脚本");
    await Bun.sleep(300);
    await agent.idle();
    expect(JSON.stringify(llmBodies.at(-1).messages)).toContain("完成:写脚本");
    expect(sent.map((s) => s.space)).toEqual(["g:9", "g:9"]);
  });
});
