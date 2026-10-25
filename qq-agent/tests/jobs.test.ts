import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { jobReport, shellEnv } from "../src/app";
import { defaultConfig, mergeConfig } from "../src/config";
import { JobManager, JobStore, stripAnsi, type Job } from "../src/jobs/jobs";
import { jobTools, openCodePromptSection } from "../src/jobs/tools";
import { LlmClient } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { systemTools } from "../src/tools/system";

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const until = Date.now() + ms;
  while (!(await cond()) && Date.now() < until) await Bun.sleep(20);
}

/** 进程已经不在了(容器里没人回收的僵尸进程也算) */
function gone(pid: number): boolean {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return true;
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function makeJobs(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qqa-jobs-"));
  const db = new Db(":memory:");
  const jobs = new JobManager({ store: new JobStore(db), dir: join(dir, "jobs"), cwd: () => dir, env: () => env, log: () => {} });
  cleanups.push(() => {
    jobs.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { jobs, dir, db };
}

describe("后台任务", () => {
  test("跑完后按退出码收尾,回调一次,输出末尾在结果里,环境变量传得进去", async () => {
    const { jobs } = makeJobs({ MY_KEY: "k123" });
    const done: Job[] = [];
    jobs.onDone = (j) => void done.push(j);
    const job = jobs.start("p:1", "echo 开始; echo key=$MY_KEY; sleep 0.3; echo 结束");
    expect(job.status).toBe("running");
    await waitFor(() => done.length > 0);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("done");
    expect(done[0]!.exitCode).toBe(0);
    expect(done[0]!.result).toContain("key=k123");
    expect(done[0]!.result).toContain("结束");
    await Bun.sleep(2500);
    expect(done).toHaveLength(1);
  });

  test("退出码非 0 算失败,错误输出也在结果里", async () => {
    const { jobs } = makeJobs();
    const done: Job[] = [];
    jobs.onDone = (j) => void done.push(j);
    jobs.start("p:1", "echo 报错了 >&2; exit 3");
    await waitFor(() => done.length > 0);
    expect(done[0]!.status).toBe("error");
    expect(done[0]!.exitCode).toBe(3);
    expect(done[0]!.result).toContain("报错了");
  });

  test("可以中止,中止的不会再回调;进程组整个被杀掉", async () => {
    const { jobs, dir } = makeJobs();
    const done: Job[] = [];
    jobs.onDone = (j) => void done.push(j);
    const job = jobs.start("p:1", `sleep 30 & echo $! > ${dir}/child.pid; wait`);
    await waitFor(() => Bun.file(`${dir}/child.pid`).size > 0);
    const child = Number((await Bun.file(`${dir}/child.pid`).text()).trim());
    expect(await jobs.abort(job.id)).toBe(true);
    expect(jobs.store.get(job.id)!.status).toBe("aborted");
    await Bun.sleep(300);
    expect(gone(child)).toBe(true);
    await Bun.sleep(2500);
    expect(done).toHaveLength(0);
    expect(await jobs.abort(job.id)).toBe(false);
  });

  test("超时的会被终止并算失败", async () => {
    const { jobs, db } = makeJobs();
    const done: Job[] = [];
    jobs.onDone = (j) => void done.push(j);
    const job = jobs.start("p:1", "sleep 30");
    db.raw.query("UPDATE jobs SET timeout_s = 0, created = created - 5 WHERE id = $id").run({ $id: job.id });
    await waitFor(() => done.length > 0);
    expect(done[0]!.status).toBe("error");
    expect(done[0]!.result).toContain("还没结束");
  });

  test("Agent 重启后接着盯:进程已经结束的任务会补上收尾", async () => {
    const { jobs, dir, db } = makeJobs();
    const job = jobs.start("p:1", "echo 重启前就跑完了");
    await waitFor(() => Bun.file(join(dir, "jobs", `${job.id}.exit`)).size > 0);
    jobs.stop();
    // 模拟重启:新的 JobManager 面对同一个数据库和目录,任务还是 running
    const again = new JobManager({ store: new JobStore(db), dir: join(dir, "jobs"), cwd: () => dir, env: () => ({}), log: () => {} });
    cleanups.push(() => again.stop());
    const done: Job[] = [];
    again.onDone = (j) => void done.push(j);
    again.startWatching();
    await waitFor(() => done.length > 0);
    expect(done[0]!.id).toBe(job.id);
    expect(done[0]!.result).toContain("重启前就跑完了");
  });

  test("进程凭空消失(没留下退出码)算失败", async () => {
    const { jobs, db } = makeJobs();
    const done: Job[] = [];
    jobs.onDone = (j) => void done.push(j);
    const job = jobs.store.create("p:1", "x", 3600);
    db.raw.query("UPDATE jobs SET pid = 999999 WHERE id = $id").run({ $id: job.id });
    jobs.startWatching();
    await waitFor(() => done.length > 0);
    expect(done[0]!.status).toBe("error");
    expect(done[0]!.result).toContain("意外消失");
  });

  test("控制序列会被去掉", () => {
    expect(stripAnsi("\u001b[0m> build\u001b[0m\n\u001b[1mdone\u001b[0m")).toBe("> build\ndone");
  });
});

describe("工具", () => {
  test("shell 的 background 返回任务号,job_* 工具能查看、中止", async () => {
    const { jobs, dir } = makeJobs();
    const reg = new ToolRegistry([...systemTools(() => dir, { jobs }), ...jobTools(jobs)]);
    const ctx = { space: "p:7", triggerSenderIds: [7] };
    const r = await reg.run("shell", JSON.stringify({ command: "echo hi; sleep 30", background: true }), ctx);
    expect(r).toContain("任务 #1");
    expect(jobs.store.get(1)!.space).toBe("p:7");
    await waitFor(async () => (await jobs.tail(jobs.store.get(1)!)).includes("hi"));
    expect(await reg.run("job_result", '{"job_id":1}', ctx)).toContain("hi");
    expect(await reg.run("job_list", "{}", ctx)).toContain("#1 [运行中]");
    expect(await reg.run("job_abort", '{"job_id":1}', ctx)).toBe("已中止");
    expect(await reg.run("job_list", "{}", ctx)).toContain("已中止");
  });

  test("前台 shell 也带环境变量;密钥、关自动升级只通过环境传入", async () => {
    const { jobs, dir } = makeJobs();
    const cfg = mergeConfig(defaultConfig, { llm: { apiKey: "sk-llm" } });
    const env = shellEnv(cfg);
    expect(env.DEEPSEEK_API_KEY).toBe("sk-llm");
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(shellEnv(mergeConfig(cfg, { opencode: { apiKey: "sk-oc" } })).DEEPSEEK_API_KEY).toBe("sk-oc");
    const reg = new ToolRegistry(systemTools(() => dir, { jobs, env: () => env }));
    expect(await reg.run("shell", '{"command":"echo $DEEPSEEK_API_KEY"}', { space: "p:1", triggerSenderIds: [1] })).toContain("sk-llm");
  });

  test("提示词里给出完整的 OpenCode 命令写法", () => {
    const t = openCodePromptSection({ workdir: "/w", bin: "/x/opencode", model: "deepseek/deepseek-flash" });
    expect(t).toContain("/x/opencode run --auto -m deepseek/deepseek-flash");
    expect(t).toContain("background=true");
    expect(t).not.toContain("sk-");
  });

  test("汇报文字", () => {
    const job = { id: 4, space: "p:1", command: "opencode run x", status: "error", exitCode: 1, pid: 1, timeoutS: 1, result: "炸了", created: 0, finished: 1 } as Job;
    expect(jobReport(job)).toContain("[后台任务 #4 失败,退出码 1]");
    expect(jobReport(job)).toContain("炸了");
  });
});

describe("任务结束后唤醒 Agent", () => {
  function setup(llmScript: (n: number) => Response | Promise<Response>) {
    const { jobs, dir, db } = makeJobs();
    let n = 0;
    const bodies: any[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.json());
        return llmScript(++n);
      },
    });
    cleanups.push(() => server.stop(true));
    const sent: string[] = [];
    const agent = new Agent({
      cfg: () => mergeConfig(defaultConfig, { behavior: { typingMsPerChar: 0 } }),
      db,
      napcat: {
        selfId: 100,
        async send(_s: any, message: any[]) {
          sent.push(message.map((m) => m.data?.text ?? "").join(""));
          return sent.length;
        },
        async call<T>() {
          return {} as T;
        },
      },
      llm: new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 })),
      tools: new ToolRegistry(memoryTools(db)),
      sleep: async () => {},
      retryDelayMs: 20,
      log: () => {},
    });
    jobs.onDone = (j) => agent.notify(j.space, jobReport(j));
    return { jobs, agent, sent, bodies, getN: () => n };
  }
  const ok = (text: string) => Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });

  test("模型看到退出码和输出,并把结果转述给发起任务的聊天", async () => {
    const { jobs, agent, sent, bodies } = setup(() => ok("<msg>搞定啦</msg>"));
    jobs.start("p:9", "echo 脚本写好了");
    await waitFor(() => sent.length > 0);
    await agent.idle();
    expect(sent).toEqual(["搞定啦"]);
    expect(JSON.stringify(bodies.at(-1).messages)).toContain("脚本写好了");
    expect(JSON.stringify(bodies.at(-1).messages)).toContain("后台任务 #1 已完成");
  });

  test("失败的任务也会汇报", async () => {
    const { jobs, agent, sent, bodies } = setup(() => ok("<msg>没成功</msg>"));
    jobs.start("p:9", "echo 模型不存在; exit 1");
    await waitFor(() => sent.length > 0);
    await agent.idle();
    expect(JSON.stringify(bodies.at(-1).messages)).toContain("失败,退出码 1");
  });

  test("通知这一轮模型接口临时出错,会自动重试而不是丢掉", async () => {
    const { jobs, agent, sent, getN } = setup((n) => (n <= 2 ? new Response("busy", { status: 503 }) : ok("<msg>做完了</msg>")));
    jobs.start("p:9", "echo hi");
    await waitFor(() => sent.length > 0, 10000);
    await agent.idle();
    expect(sent).toEqual(["做完了"]);
    expect(getN()).toBe(3);
  });

  test("一直失败最多重试 3 次就放弃", async () => {
    const { jobs, sent, getN } = setup(() => new Response("down", { status: 503 }));
    jobs.start("p:9", "echo hi");
    await waitFor(() => getN() >= 4, 10000);
    await Bun.sleep(400);
    expect(getN()).toBe(4);
    expect(sent).toEqual([]);
  });
});
