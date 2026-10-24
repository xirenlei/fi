import { mkdirSync } from "node:fs";
import type { Config } from "../config";
import { OpenCodeClient, collectResult } from "./client";
import { TaskStore, type OcTask } from "./tasks";

export interface TaskDone {
  task: OcTask;
  status: "done" | "error";
  result: string;
}

/** 管理 OpenCode 服务进程、提交任务并在完成时回调 */
export class OpenCodeManager {
  readonly client: OpenCodeClient;
  private abortWatch?: AbortController;
  private proc?: ReturnType<typeof Bun.spawn>;
  onDone: (d: TaskDone) => void | Promise<void> = () => {};

  constructor(
    private cfg: () => Config,
    readonly tasks: TaskStore,
    private log: (m: string) => void = console.log,
  ) {
    const oc = cfg().opencode;
    this.client = new OpenCodeClient({ baseUrl: oc.baseUrl, directory: this.workdir(), password: oc.password || undefined });
  }

  workdir(): string {
    const dir = this.cfg().opencode.workdir;
    if (!dir) throw new Error("opencode.workdir 未配置");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 服务没起来时按配置启动 `opencode serve` */
  async ensureRunning(): Promise<void> {
    if (await this.client.healthy()) return;
    const oc = this.cfg().opencode;
    if (!oc.autoStart) throw new Error("OpenCode 服务没有运行");
    const url = new URL(oc.baseUrl);
    this.log(`starting opencode serve on ${url.host}`);
    const env: Record<string, string | undefined> = { ...process.env };
    if (oc.password) env.OPENCODE_SERVER_PASSWORD = oc.password;
    this.proc = Bun.spawn([oc.bin || "opencode", "serve", "--hostname", url.hostname, "--port", url.port || "4096"], {
      cwd: this.workdir(),
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 40; i++) {
      if (await this.client.healthy()) return;
      await Bun.sleep(500);
    }
    throw new Error("OpenCode 服务启动超时");
  }

  /** 把 DeepSeek 密钥和模型写进 OpenCode,并放开权限让无人值守的任务不会卡在确认上 */
  async configure(): Promise<void> {
    const cfg = this.cfg();
    await this.ensureRunning();
    const key = cfg.opencode.apiKey || cfg.llm.apiKey;
    if (key) await this.client.setAuth("deepseek", key);
    const patch: Record<string, unknown> = { permission: { bash: "allow", edit: "allow", webfetch: "allow" } };
    if (cfg.opencode.model) patch.model = cfg.opencode.model;
    await this.client.patchConfig(patch);
  }

  async submit(space: string, prompt: string, sessionId?: string): Promise<OcTask> {
    await this.ensureRunning();
    const sid = sessionId ?? (await this.client.createSession(prompt.slice(0, 40))).id;
    const running = this.tasks.runningForSession(sid);
    if (running) throw new Error(`会话 ${sid} 还有任务 #${running.id} 在运行`);
    const task = this.tasks.create(sid, space, prompt);
    try {
      await this.client.promptAsync(sid, prompt, this.model());
    } catch (e) {
      this.tasks.finish(task.id, "error", String(e));
      throw e;
    }
    this.startWatching();
    return task;
  }

  /** 配置里的 provider/model 拆成接口需要的结构;不写则用 OpenCode 自己的默认模型 */
  private model(): { providerID: string; modelID: string } | undefined {
    const m = this.cfg().opencode.model;
    const i = m.indexOf("/");
    return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : undefined;
  }

  async abort(taskId: number): Promise<boolean> {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "running") return false;
    await this.client.abort(t.sessionId).catch(() => {});
    this.tasks.finish(taskId, "aborted", "已中止");
    return true;
  }

  async fullResult(task: OcTask): Promise<string> {
    if (task.status === "running") return "任务还在运行";
    if (task.result) return task.result;
    return collectResult(await this.client.messages(task.sessionId)).text || "(没有文字输出)";
  }

  /** 开始监听事件流(幂等),断线自动重连 */
  startWatching(): void {
    if (this.abortWatch) return;
    const ac = (this.abortWatch = new AbortController());
    void (async () => {
      let delay = 1000;
      while (!ac.signal.aborted) {
        try {
          await this.client.subscribe((e) => void this.handleEvent(e), ac.signal);
          delay = 1000;
        } catch (e) {
          if (ac.signal.aborted) return;
          this.log(`opencode event stream error: ${e}`);
        }
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 15_000);
        // 断线期间可能错过完成事件,重连后补查
        void this.reconcile();
      }
    })();
  }

  stopWatching(): void {
    this.abortWatch?.abort();
    this.abortWatch = undefined;
  }

  async stop(): Promise<void> {
    this.stopWatching();
    this.proc?.kill();
  }

  private async handleEvent(e: { type: string; properties: Record<string, any> }) {
    if (e.type !== "session.idle" && e.type !== "session.error") return;
    const sid = e.properties.sessionID as string | undefined;
    if (!sid) return;
    const task = this.tasks.runningForSession(sid);
    if (task) await this.settle(task);
  }

  /** 查看任务对应会话是否已结束,结束则收尾并回调 */
  async settle(task: OcTask): Promise<void> {
    let r;
    try {
      r = collectResult(await this.client.messages(task.sessionId));
    } catch (e) {
      this.log(`failed to read session ${task.sessionId}: ${e}`);
      return;
    }
    if (!r.completed && !r.error) return;
    if (this.tasks.get(task.id)?.status !== "running") return;
    const status = r.error ? "error" : "done";
    const result = r.error ? `${r.error}${r.text ? `\n${r.text}` : ""}` : r.text || "(没有文字输出)";
    this.tasks.finish(task.id, status, result);
    await this.onDone({ task: this.tasks.get(task.id)!, status, result });
  }

  async reconcile(): Promise<void> {
    for (const t of this.tasks.running()) await this.settle(t);
  }
}
