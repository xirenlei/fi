import { join } from "node:path";
import { dataDir, loadConfig } from "./config";
import { Agent } from "./agent/agent";
import { ToolRegistry, memoryTools } from "./agent/tools";
import { LlmClient } from "./llm/client";
import { Db } from "./memory/db";
import { NapcatClient } from "./napcat/client";

const cfg = loadConfig();
const db = new Db(join(dataDir(), "agent.db"));
const napcat = new NapcatClient({ wsUrl: cfg.napcat.wsUrl, token: cfg.napcat.token });
const llm = new LlmClient(() => ({ baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, extraBody: cfg.llm.extraBody }));
const tools = new ToolRegistry(memoryTools(db));
const agent = new Agent({ cfg: () => cfg, db, napcat, llm, tools });

napcat.onEvent((ev) => agent.handleEvent(ev));
napcat.connect();
await napcat.waitOpen(30_000);
const me = await napcat.getLoginInfo();
console.log(`logged in as ${me.nickname} (${me.user_id})`);
