import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Config {
  napcat: {
    /** NapCat 正向 WebSocket 地址 */
    wsUrl: string;
    token: string;
    /** NapCat 自带管理界面(扫码登录用)的地址,仅用于控制台里的链接 */
    webuiUrl: string;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    /** 主对话模型 */
    model: string;
    /** 群聊插嘴判定、图片描述等轻量请求用的模型 */
    lightModel: string;
    thinking: {
      enabled: boolean;
      /** 思考强度,原样透传给接口 */
      effort: "low" | "medium" | "high";
    };
    /** 额外合并进请求体的字段,用于适配接口参数的变化 */
    extraBody: Record<string, unknown>;
  };
  /** 人设,写进系统提示词 */
  persona: string;
  behavior: {
    /** 模拟打字:每个字的等待毫秒数,0 表示不等待 */
    typingMsPerChar: number;
    maxTypingMs: number;
  };
  memory: {
    /** 一个会话的近期消息涨到这个数就整理一次 */
    maxMessages: number;
    /** 每次整理最老的多少条(整理后近期消息在 maxMessages - compactMessages 到 maxMessages 之间) */
    compactMessages: number;
    /** 长期记忆超过这个字数就让模型整理合并 */
    maxMemoryChars: number;
  };
  group: {
    /** 被 @ 或被回复时必回 */
    alwaysReplyWhenMentioned: boolean;
    /** 同一群两次主动插嘴之间的最短间隔(秒) */
    cooldownSeconds: number;
    /** 判定时附带的最近消息条数 */
    judgeContext: number;
  };
  /** 管理员的 QQ 号,写进提示词:管理员的话优先听。不做硬性的权限限制,由模型自己判断 */
  admins: number[];
  /** 好友请求、入群邀请的处理方式:agent 交给它自己判断,notify 只通知管理员,reject 一律拒绝 */
  requests: {
    mode: "agent" | "notify" | "reject";
  };
  /** 自主行动:没人说话时,隔一段时间让它自己决定做点什么(发动态、改签名、主动找人聊天等) */
  proactive: {
    enabled: boolean;
    /** 平均间隔(分钟),实际会在 ±30% 内随机浮动 */
    intervalMinutes: number;
    /** 安静时段(含起点,不含终点,本地时间的小时),这段时间不会自己行动 */
    quietStartHour: number;
    quietEndHour: number;
  };
  opencode: {
    /** OpenCode 干活的目录 */
    workdir: string;
    baseUrl: string;
    /** 服务没运行时自动启动 */
    autoStart: boolean;
    bin: string;
    password: string;
    /** 写入 OpenCode 的 DeepSeek 密钥 */
    apiKey: string;
    /** OpenCode 使用的模型,格式 provider/model */
    model: string;
  };
  web: {
    port: number;
  };
}

export const defaultConfig: Config = {
  napcat: { wsUrl: "ws://127.0.0.1:3001", token: "", webuiUrl: "http://127.0.0.1:6099/webui" },
  llm: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-flash",
    lightModel: "deepseek-flash",
    thinking: { enabled: true, effort: "medium" },
    extraBody: {},
  },
  persona:
    "你是一个 QQ 账号背后的助理,说话自然、简短,像普通网友一样聊天,不要自称 AI 助手,不要长篇大论。熟人之间可以随意,遇到正事就认真处理。",
  behavior: { typingMsPerChar: 60, maxTypingMs: 3000 },
  memory: { maxMessages: 200, compactMessages: 100, maxMemoryChars: 4500 },
  group: { alwaysReplyWhenMentioned: true, cooldownSeconds: 20, judgeContext: 20 },
  admins: [],
  requests: { mode: "agent" },
  proactive: { enabled: true, intervalMinutes: 120, quietStartHour: 1, quietEndHour: 8 },
  opencode: {
    workdir: "",
    baseUrl: "http://127.0.0.1:4096",
    autoStart: true,
    bin: "opencode",
    password: "",
    apiKey: "",
    model: "deepseek/deepseek-flash",
  },
  web: { port: 8765 },
};

/** 数据目录:配置、数据库、图库都放在这里,不进仓库 */
export function dataDir(): string {
  return process.env.QQ_AGENT_HOME ?? join(homedir(), ".config", "qq-agent");
}

export function configPath(): string {
  return join(dataDir(), "config.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && isObject((base as Record<string, unknown>)[k]) ? mergeConfig((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function loadConfig(path = configPath()): Config {
  const cfg = existsSync(path)
    ? mergeConfig(structuredClone(defaultConfig), JSON.parse(readFileSync(path, "utf8")))
    : structuredClone(defaultConfig);
  if (!cfg.opencode.workdir) cfg.opencode.workdir = join(dataDir(), "workspace");
  return cfg;
}

export function saveConfig(cfg: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
