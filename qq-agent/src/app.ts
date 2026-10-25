import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "./agent/agent";
import { Scheduler } from "./agent/scheduler";
import { ToolRegistry, memoryTools } from "./agent/tools";
import { dataDir, loadConfig, type Config } from "./config";
import { LlmClient } from "./llm/client";
import { MediaPipeline } from "./media/handler";
import { MediaStore } from "./media/store";
import { mediaTools } from "./media/tools";
import { Db } from "./memory/db";
import { NapcatClient } from "./napcat/client";
import { JobManager, JobStore, type Job } from "./jobs/jobs";
import { jobTools, openCodePromptSection } from "./jobs/tools";
import { accountPromptSection, accountTools } from "./tools/account";
import { chatTools } from "./tools/chat";
import { qqApiPromptSection, qqApiTools } from "./tools/qqapi";
import { loadCatalog } from "./napcat/catalog";
import { systemTools } from "./tools/system";

export interface App {
  cfg: Config;
  db: Db;
  napcat: NapcatClient;
  agent: Agent;
  jobs: JobManager;
  store: MediaStore;
  startedAt: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** 每条 shell 命令都带上的环境变量:OpenCode 用的 DeepSeek 密钥,并关掉它的自动升级和彩色输出 */
export function shellEnv(cfg: Config): Record<string, string> {
  const env: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1" };
  const key = cfg.opencode.apiKey || cfg.llm.apiKey;
  if (key) env.DEEPSEEK_API_KEY = key;
  return env;
}

/** 后台任务结束后写给 Agent 的系统消息 */
export function jobReport(job: Job): string {
  const head = job.status === "done" ? "已完成" : job.status === "aborted" ? "已中止" : `失败${job.exitCode != null ? `,退出码 ${job.exitCode}` : ""}`;
  return `[后台任务 #${job.id} ${head}]\n命令:${job.command.slice(0, 300)}\n输出末尾:\n${job.result.slice(-3000) || "(没有输出)"}`;
}

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** 把各个模块组装起来。配置对象是活的:控制台保存设置后,大部分选项立即生效 */
export function createApp(cfg: Config = loadConfig()): App {
  const db = new Db(join(dataDir(), "agent.db"));
  const workdir = () => {
    mkdirSync(cfg.opencode.workdir, { recursive: true });
    return cfg.opencode.workdir;
  };
  const napcat = new NapcatClient({ wsUrl: cfg.napcat.wsUrl, token: cfg.napcat.token, log });
  const llm = new LlmClient(() => ({ baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, extraBody: cfg.llm.extraBody }));
  const store = new MediaStore(db, join(dataDir(), "media"));
  const media = new MediaPipeline({ store, llm, cfg: () => cfg, log });
  const jobs = new JobManager({
    store: new JobStore(db),
    dir: join(dataDir(), "jobs"),
    cwd: () => workdir(),
    env: () => shellEnv(cfg),
    log,
  });

  const tools = new ToolRegistry([
    ...memoryTools(db),
    ...mediaTools(store),
    ...jobTools(jobs),
    ...systemTools(() => workdir(), { jobs, env: () => shellEnv(cfg) }),
    ...accountTools({ call: (action, params) => napcat.call(action, params), store }),
    ...chatTools({ db, say: (space, raw) => agent.say(space, raw) }),
    ...qqApiTools({ call: (action, params) => napcat.call(action, params) }),
  ]);
  const agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm,
    tools,
    media,
    extraSections: () => [openCodePromptSection({ workdir: workdir(), bin: cfg.opencode.bin, model: cfg.opencode.model }), accountPromptSection(), qqApiPromptSection(loadCatalog().length)],
    log,
  });

  napcat.onEvent((ev) => agent.handleEvent(ev));
  jobs.onDone = (job) => {
    const text = jobReport(job);
    // 自己在自由时间启动的任务,没有对应的聊天可汇报,唤醒它自己处理
    if (job.space === "self") void agent.wander(text).catch((e) => log(`wander failed: ${e}`));
    else agent.notify(job.space, text);
  };

  const scheduler = new Scheduler({
    enabled: () => cfg.proactive.enabled,
    intervalMinutes: () => cfg.proactive.intervalMinutes,
    quiet: () => [cfg.proactive.quietStartHour, cfg.proactive.quietEndHour],
    run: async () => {
      const said = await agent.wander();
      if (said) log(`[proactive] ${said.slice(0, 200)}`);
    },
    log,
  });

  return {
    cfg,
    db,
    napcat,
    agent,
    jobs,
    store,
    startedAt: Date.now(),
    async start() {
      napcat.connect();
      scheduler.start();
      // 接着盯上次没跑完的后台任务(Agent 重启、更新期间结束的也会在这里补上汇报)
      jobs.startWatching();
    },
    async stop() {
      scheduler.stop();
      napcat.close();
      jobs.stop();
      db.close();
    },
  };
}
