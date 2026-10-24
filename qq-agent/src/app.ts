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
import { OpenCodeManager } from "./opencode/manager";
import { TaskStore } from "./opencode/tasks";
import { openCodePromptSection, openCodeTools } from "./opencode/tools";
import { accountPromptSection, accountTools } from "./tools/account";
import { chatTools } from "./tools/chat";
import { systemTools } from "./tools/system";

export interface App {
  cfg: Config;
  db: Db;
  napcat: NapcatClient;
  agent: Agent;
  oc: OpenCodeManager;
  store: MediaStore;
  startedAt: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** 把各个模块组装起来。配置对象是活的:控制台保存设置后,大部分选项立即生效 */
export function createApp(cfg: Config = loadConfig()): App {
  const db = new Db(join(dataDir(), "agent.db"));
  const napcat = new NapcatClient({ wsUrl: cfg.napcat.wsUrl, token: cfg.napcat.token, log });
  const llm = new LlmClient(() => ({ baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, extraBody: cfg.llm.extraBody }));
  const store = new MediaStore(db, join(dataDir(), "media"));
  const media = new MediaPipeline({ store, llm, cfg: () => cfg, log });
  const oc = new OpenCodeManager(() => cfg, new TaskStore(db), log);

  const tools = new ToolRegistry([
    ...memoryTools(db),
    ...mediaTools(store),
    ...openCodeTools(oc),
    ...systemTools(() => oc.workdir()),
    ...accountTools({ call: (action, params) => napcat.call(action, params), store }),
    ...chatTools({ db, say: (space, raw) => agent.say(space, raw) }),
  ]);
  const agent = new Agent({
    cfg: () => cfg,
    db,
    napcat,
    llm,
    tools,
    media,
    extraSections: () => [openCodePromptSection(cfg.opencode.workdir), accountPromptSection()],
    log,
  });

  napcat.onEvent((ev) => agent.handleEvent(ev));
  oc.onDone = ({ task, status, result }) => {
    const head = status === "done" ? "已完成" : "失败";
    const text = `[OpenCode 任务 #${task.id} ${head}]\n任务:${task.prompt}\n结果:\n${result.slice(0, 3000)}`;
    // 自己在自由时间提交的任务,没有对应的聊天可汇报,唤醒它自己处理
    if (task.space === "self") void agent.wander(text).catch((e) => log(`wander failed: ${e}`));
    else agent.notify(task.space, text);
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

  /** OpenCode 服务可能比 Agent 晚起来,所以重试一段时间 */
  let stopped = false;
  async function setupOpenCode() {
    for (let i = 0; i < 24 && !stopped; i++) {
      try {
        await oc.configure();
        oc.startWatching();
        await oc.reconcile();
        return;
      } catch (e) {
        if (i === 0) log(`opencode not ready yet (${e}); will retry`);
        await Bun.sleep(5000);
      }
    }
    log("opencode setup gave up; restart the agent after fixing OpenCode");
  }

  return {
    cfg,
    db,
    napcat,
    agent,
    oc,
    store,
    startedAt: Date.now(),
    async start() {
      napcat.connect();
      scheduler.start();
      // OpenCode 的准备不阻塞聊天功能
      void setupOpenCode();
    },
    async stop() {
      stopped = true;
      scheduler.stop();
      napcat.close();
      await oc.stop();
      db.close();
    },
  };
}
