// 安装脚本调用:写入 Agent 配置,并让 NapCat 开启本机 WebSocket 服务(带 token)。
// 可重复运行:已有的设置和 token 会保留。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, mergeConfig, type Config } from "../src/config";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const dataDir = need("DATA_DIR");
const workdir = need("WORKDIR");
const opencodeBin = need("OPENCODE_BIN");
const napcatConfigDir = need("NAPCAT_CONFIG_DIR");

const hex = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
const readJson = (p: string): any => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const writeJson = (p: string, v: unknown) => {
  writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
};

mkdirSync(dataDir, { recursive: true });
mkdirSync(napcatConfigDir, { recursive: true });

// NapCat 管理界面:只监听本机,token 固定下来方便控制台直接链接
const webuiPath = join(napcatConfigDir, "webui.json");
const webui = readJson(webuiPath) ?? {};
webui.host = "127.0.0.1";
webui.port ??= 6099;
webui.token = typeof webui.token === "string" && webui.token.length >= 8 ? webui.token : hex(8);
writeJson(webuiPath, webui);

// Agent 配置
const cfgPath = join(dataDir, "config.json");
const existing = readJson(cfgPath) ?? {};
const wsToken: string = existing?.napcat?.token || hex(16);
const wsPort = 3001;
const merged: Config = mergeConfig(structuredClone(defaultConfig), existing);
merged.napcat.wsUrl = existing?.napcat?.wsUrl || `ws://127.0.0.1:${wsPort}`;
merged.napcat.token = wsToken;
merged.napcat.webuiUrl = `http://127.0.0.1:${webui.port}/webui?token=${webui.token}`;
if (!merged.opencode.workdir) merged.opencode.workdir = workdir;
merged.opencode.bin = opencodeBin;
// 旧版本里 OpenCode 是常驻服务,这些设置已经不用了,清掉(其中有密码)
for (const k of ["baseUrl", "autoStart", "password"]) delete (merged.opencode as Record<string, unknown>)[k];
writeJson(cfgPath, merged);

// NapCat 的 OneBot 配置:onebot11.json 是新账号的模板;已登录过的账号有自己的 onebot11_<QQ号>.json,一并改掉
const wsServer = {
  name: "qq-agent",
  enable: true,
  host: "127.0.0.1",
  port: wsPort,
  messagePostFormat: "array",
  reportSelfMessage: true,
  token: wsToken,
  enableForcePushEvent: true,
  debug: false,
  heartInterval: 30000,
};
const template = {
  network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [wsServer], websocketClients: [], plugins: [] },
  musicSignUrl: "",
  enableLocalFile2Url: false,
  parseMultMsg: false,
};
writeJson(join(napcatConfigDir, "onebot11.json"), template);
for (const f of readdirSync(napcatConfigDir)) {
  if (!/^onebot11_\d+\.json$/.test(f)) continue;
  const p = join(napcatConfigDir, f);
  const c = readJson(p) ?? {};
  c.network ??= {};
  const others = (c.network.websocketServers ?? []).filter((s: any) => s.name !== wsServer.name && s.port !== wsPort);
  c.network.websocketServers = [wsServer, ...others];
  writeJson(p, c);
}

console.log(`config: ${cfgPath}`);
console.log(`napcat webui: http://127.0.0.1:${webui.port}/webui?token=${webui.token}`);
