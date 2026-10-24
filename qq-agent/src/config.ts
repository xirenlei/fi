import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Config {
  napcat: {
    /** NapCat 正向 WebSocket 地址 */
    wsUrl: string;
    token: string;
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
    /** 只回传最近 N 轮的思考内容 */
    reasoningRounds: number;
  };
  memory: {
    /** 每个空间保留的原始消息条数,更早的做摘要 */
    windowSize: number;
  };
  group: {
    /** 被 @ 或被回复时必回 */
    alwaysReplyWhenMentioned: boolean;
    /** 同一群两次主动插嘴之间的最短间隔(秒) */
    cooldownSeconds: number;
    /** 判定时附带的最近消息条数 */
    judgeContext: number;
  };
  /** 允许让 Agent 调用 OpenCode / 执行命令的 QQ 号 */
  admins: number[];
  opencode: {
    workdir: string;
    baseUrl: string;
  };
  web: {
    port: number;
  };
}

export const defaultConfig: Config = {
  napcat: { wsUrl: "ws://127.0.0.1:3001", token: "" },
  llm: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-flash",
    lightModel: "deepseek-flash",
    thinking: { enabled: true, effort: "medium" },
    reasoningRounds: 20,
  },
  memory: { windowSize: 200 },
  group: { alwaysReplyWhenMentioned: true, cooldownSeconds: 20, judgeContext: 20 },
  admins: [],
  opencode: { workdir: "", baseUrl: "http://127.0.0.1:4096" },
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
  if (!existsSync(path)) return structuredClone(defaultConfig);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return mergeConfig(structuredClone(defaultConfig), raw);
}

export function saveConfig(cfg: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
