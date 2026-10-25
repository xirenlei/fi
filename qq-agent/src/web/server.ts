import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app";
import { configPath, dataDir, mergeConfig, saveConfig, type Config } from "../config";
import type { MediaKind } from "../media/store";
import { runShell } from "../tools/system";

const SECRET_PATHS = [
  ["llm", "apiKey"],
  ["napcat", "token"],
  ["opencode", "apiKey"],
  ["opencode", "password"],
] as const;
const MASK = "***";
const LOG_NAMES = ["agent", "napcat", "opencode"] as const;
const SERVICES = ["agent", "napcat", "opencode"] as const;

type Json = Record<string, any>;

/** 返回给前端的配置:密钥只显示是否已设置 */
export function maskConfig(cfg: Config): Json {
  const out = structuredClone(cfg) as Json;
  for (const [a, b] of SECRET_PATHS) if (out[a][b]) out[a][b] = MASK;
  return out;
}

/** 把前端提交的配置并入现有配置;值为 *** 的密钥保持不变 */
export function applyConfig(cfg: Config, incoming: Json): { changed: string[] } {
  const patch = structuredClone(incoming);
  for (const [a, b] of SECRET_PATHS) if (patch?.[a]?.[b] === MASK) delete patch[a][b];
  if (patch.admins !== undefined) {
    if (!Array.isArray(patch.admins) || !patch.admins.every((n: unknown) => Number.isInteger(n) && (n as number) > 0)) {
      throw new Error("admins 必须是 QQ 号(正整数)的数组");
    }
  }
  const merged = mergeConfig(cfg, patch) as Json;
  const next = merged as unknown as Config;
  const mem = next.memory;
  if (!(mem.maxMessages >= 40)) throw new Error("memory.maxMessages 至少为 40");
  if (!(mem.compactMessages >= 10 && mem.compactMessages <= mem.maxMessages - 10)) throw new Error("memory.compactMessages 要在 10 到 maxMessages-10 之间");
  if (!(mem.maxMemoryChars >= 1000)) throw new Error("memory.maxMemoryChars 至少为 1000");
  if (!(next.web.port > 0 && next.web.port < 65536)) throw new Error("web.port 不合法");
  const changed: string[] = [];
  for (const k of Object.keys(next) as Array<keyof Config>) {
    if (JSON.stringify(next[k]) !== JSON.stringify(cfg[k])) changed.push(k);
  }
  Object.assign(cfg, next);
  return { changed };
}

function tail(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const buf = readFileSync(path);
  const text = buf.subarray(Math.max(0, size - 256 * 1024)).toString("utf8");
  return text.split("\n").slice(-lines).join("\n");
}

/** 读安装脚本写下的 install.env(KEY='value' 每行一个) */
export function readInstallEnv(dir = dataDir()): Record<string, string> {
  const path = join(dir, "install.env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)='(.*)'$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface UpdateInfo {
  supported: boolean;
  reason?: string;
  current?: { hash: string; subject: string; date: string };
  behind?: number;
  commits?: string[];
  running: boolean;
}

const updateLock = () => join(dataDir(), "run", "update.lock");

/** 当前版本,以及远端有没有新提交(会 fetch 一次) */
export async function checkUpdate(): Promise<UpdateInfo> {
  const env = readInstallEnv();
  const repo = env.APP_DIR ? join(env.APP_DIR, "repo") : "";
  const running = existsSync(updateLock());
  if (!repo || !existsSync(join(repo, ".git"))) return { supported: false, reason: "不是通过仓库安装的(本地目录安装),请重新运行安装命令来更新", running };
  const git = (args: string) => runShell(`git -C '${repo}' ${args}`, repo, 30_000);
  const fetched = await git(`fetch -q --depth 100 origin '${env.BRANCH || "main"}'`);
  if (fetched.code !== 0) return { supported: true, reason: `获取远端信息失败:${fetched.output.slice(0, 200)}`, running };
  const cur = await git(`log -1 --format=%h%x09%cs%x09%s HEAD`);
  const [hash = "", date = "", ...subject] = cur.output.split("\t");
  const log = await git(`log --format='%h %s' HEAD..FETCH_HEAD`);
  if (log.code !== 0) return { supported: true, reason: `比较版本失败:${log.output.slice(0, 200)}`, running };
  const commits = log.output.split("\n").filter(Boolean);
  return { supported: true, current: { hash, date, subject: subject.join("\t") }, behind: commits.length, commits, running };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

export function startWeb(app: App, port = app.cfg.web.port) {
  const log = (m: string) => console.log(`[web] ${m}`);
  const htmlPath = join(import.meta.dir, "index.html");

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // 只接受本机访问,防止 DNS 重绑定;写操作必须带自定义头,防止跨站请求
      const host = (req.headers.get("host") ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return bad("forbidden", 403);
      if (req.method !== "GET" && req.headers.get("x-qq-agent") !== "1") return bad("forbidden", 403);

      try {
        return await route(req, url);
      } catch (e) {
        log(`${req.method} ${url.pathname}: ${e}`);
        return bad(e instanceof Error ? e.message : String(e), 500);
      }
    },
  });

  async function route(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;
    const m = req.method;
    if (m === "GET" && (p === "/" || p === "/index.html")) {
      return new Response(readFileSync(htmlPath), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (p === "/api/status" && m === "GET") {
      return json({
        uptimeSec: Math.floor((Date.now() - app.startedAt) / 1000),
        napcat: { connected: app.napcat.connected, selfId: app.napcat.selfId ?? null, webuiUrl: app.cfg.napcat.webuiUrl },
        opencode: { healthy: await app.oc.client.healthy(), running: app.oc.tasks.running().length },
        spaces: app.db.listSpaces().length,
        media: app.store.list({ limit: 100000 }).length,
        memories: app.db.allMemories().length,
        configPath: configPath(),
        dataDir: dataDir(),
      });
    }

    if (p === "/api/config") {
      if (m === "GET") return json(maskConfig(app.cfg));
      if (m === "PUT") {
        const before = structuredClone(app.cfg);
        const { changed } = applyConfig(app.cfg, await req.json());
        saveConfig(app.cfg);
        const restartRequired =
          before.napcat.wsUrl !== app.cfg.napcat.wsUrl || before.napcat.token !== app.cfg.napcat.token || before.web.port !== app.cfg.web.port;
        const ocChanged =
          before.opencode.model !== app.cfg.opencode.model ||
          before.opencode.apiKey !== app.cfg.opencode.apiKey ||
          before.llm.apiKey !== app.cfg.llm.apiKey;
        if (ocChanged) app.oc.configure().catch((e) => log(`opencode configure failed: ${e}`));
        return json({ ok: true, changed, restartRequired });
      }
    }

    if (p === "/api/spaces" && m === "GET") {
      return json(
        app.db.listSpaces().map((s) => {
          const row = app.db.getSpace(s);
          return { space: s, title: row.title, messages: app.db.count(s), hasSummary: !!row.summary };
        }),
      );
    }
    const sp = p.match(/^\/api\/spaces\/([gp]:\d+)$/);
    if (sp && m === "GET") {
      const space = sp[1]!;
      return json({ ...app.db.getSpace(space), messages: app.db.recent(space, 100) });
    }

    if (p === "/api/memories") {
      if (m === "GET") return json(app.db.allMemories());
      if (m === "POST") {
        const b = (await req.json()) as Json;
        if (!/^(global|user:\d+|space:[gp]:\d+)$/.test(b.subject ?? "") || !String(b.content ?? "").trim()) return bad("subject 或 content 不合法");
        return json({ id: app.db.addMemory(b.subject, String(b.content).trim()) });
      }
    }
    const mem = p.match(/^\/api\/memories\/(\d+)$/);
    if (mem && m === "DELETE") return json({ ok: app.db.deleteMemory(Number(mem[1])) });

    if (p === "/api/media" && m === "GET") {
      const kind = (url.searchParams.get("kind") || null) as MediaKind | null;
      const q = url.searchParams.get("q") ?? "";
      const opts = { kind: kind ?? undefined, limit: 200 };
      return json(q ? app.store.search(q, opts) : app.store.list(opts));
    }
    const med = p.match(/^\/api\/media\/(\d+)(\/file)?$/);
    if (med) {
      const item = app.store.get(Number(med[1]));
      if (!item) return bad("not found", 404);
      if (med[2] && m === "GET") return new Response(Bun.file(app.store.absPath(item)), { headers: { "content-type": item.mime } });
      if (m === "DELETE") return json({ ok: app.store.remove(item.id) });
      if (m === "PATCH") {
        const b = (await req.json()) as Json;
        if (!["image", "sticker", "video"].includes(b.kind) || (item.kind === "video") !== (b.kind === "video")) return bad("kind 不合法");
        return json(app.store.setKind(item.id, b.kind));
      }
    }

    if (p === "/api/update/check" && m === "GET") return json(await checkUpdate());
    if (p === "/api/update/log" && m === "GET") {
      return json({ running: existsSync(updateLock()), text: tail(join(dataDir(), "logs", "update.log"), 200) });
    }
    if (p === "/api/update/run" && m === "POST") {
      const env = readInstallEnv();
      const ctl = process.env.QQ_AGENT_CTL || (env.APP_DIR ? join(process.env.HOME ?? "", ".local", "bin", "qq-agent") : "");
      if (!ctl || !existsSync(ctl)) return bad("找不到 qq-agent 命令,无法更新", 500);
      if (existsSync(updateLock())) return bad("已经有更新在进行中", 409);
      const log = join(dataDir(), "logs", "update.log");
      // 更新过程会重启 Agent 自己,所以必须让它脱离当前进程组/服务运行
      const quoted = `'${ctl}' update >> '${log}' 2>&1`;
      const useSystemd = (await runShell("systemctl --user show-environment >/dev/null 2>&1", dataDir(), 5000)).code === 0;
      const launch = useSystemd
        ? `systemd-run --user --collect --quiet --unit=qq-agent-update --setenv=QQ_AGENT_HOME='${dataDir()}' bash -c "${quoted.replace(/"/g, '\\"')}"`
        : `setsid nohup bash -c "${quoted.replace(/"/g, '\\"')}" >/dev/null 2>&1 &`;
      writeFileSync(log, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] 开始更新\n`);
      const r = await runShell(launch, dataDir(), 10_000);
      return json({ ok: r.code === 0, output: r.output });
    }

    if (p === "/api/proactive/run" && m === "POST") {
      if (!app.napcat.connected) return bad("QQ 还没连上,先登录 NapCat", 409);
      const text = await app.agent.wander();
      return json({ ok: true, text });
    }

    if (p === "/api/tasks" && m === "GET") return json(app.oc.tasks.recent(50));
    const tk = p.match(/^\/api\/tasks\/(\d+)\/abort$/);
    if (tk && m === "POST") return json({ ok: await app.oc.abort(Number(tk[1])) });

    const lg = p.match(/^\/api\/logs\/(\w+)$/);
    if (lg && m === "GET") {
      const name = lg[1] as (typeof LOG_NAMES)[number];
      if (!LOG_NAMES.includes(name)) return bad("unknown log", 404);
      return json({ text: tail(join(dataDir(), "logs", `${name}.log`), Number(url.searchParams.get("lines")) || 200) });
    }

    const sv = p.match(/^\/api\/services\/(\w+)\/(start|stop|restart)$/);
    if (sv && m === "POST") {
      const name = sv[1] as (typeof SERVICES)[number];
      const action = sv[2]!;
      if (!SERVICES.includes(name)) return bad("unknown service", 404);
      if (name === "agent") {
        if (action === "start") return json({ ok: true });
        // 进程退出后由 systemd 重新拉起
        setTimeout(() => process.exit(0), 300);
        return json({ ok: true, note: "agent 即将重启" });
      }
      const ctl = process.env.QQ_AGENT_CTL;
      const cmd = ctl ? `'${ctl}' ${action} ${name}` : `systemctl --user ${action} qq-agent-${name}.service`;
      const r = await runShell(cmd, dataDir(), 30_000);
      return json({ ok: r.code === 0, output: r.output });
    }

    return bad("not found", 404);
  }

  log(`console listening on http://127.0.0.1:${server.port}`);
  return server;
}
