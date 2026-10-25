import { defineTool, type Tool } from "../agent/tools";
import { formatEntry, loadCatalog, searchCatalog, type CatalogEntry } from "../napcat/catalog";

/** 不交给模型的接口:会泄露登录凭证,或会让整个 QQ 进程退出 */
export const DENIED_ACTIONS = new Set(["bot_exit", "set_restart", "get_cookies", "get_credentials", "get_csrf_token", "get_clientkey", "send_packet"]);

const RESULT_LIMIT = 6000;

export interface QqApiDeps {
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
  catalog?: () => CatalogEntry[];
}

function show(data: unknown): string {
  const text = JSON.stringify(data ?? null, null, 1);
  if (text.length <= RESULT_LIMIT) return text;
  const arr = Array.isArray(data) ? `(共 ${data.length} 项)` : "";
  return `${text.slice(0, RESULT_LIMIT)}\n…(结果太长已截断${arr},可以缩小范围或分页再查)`;
}

const when = (ts: unknown): string => {
  const n = Number(ts);
  return n > 0 ? new Date(n * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
};

const ROLE: Record<string, string> = { owner: "群主", admin: "管理员", member: "成员" };

/** 把对象里非空的标量字段排成一行行文字,用于展示资料 */
function scalars(obj: Record<string, unknown> | null | undefined, skip: string[] = []): string {
  if (!obj) return "(没有数据)";
  return Object.entries(obj)
    .filter(([k, v]) => !skip.includes(k) && v !== "" && v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** 通用接口:NapCat 的全部接口都能通过它调用;外加几个最常用、结果经过整理的专用工具 */
export function qqApiTools(d: QqApiDeps): Tool[] {
  const catalog = () => (d.catalog ?? loadCatalog)();

  return [
    defineTool(
      "qq_api_search",
      "搜索 NapCat 提供的全部 QQ 接口(群管理、好友、文件、历史消息、合并转发、语音转文字、AI 语音、精华消息、群相册、群公告、点赞等等),返回接口名和参数。不确定有没有某个能力时先搜一下。不带关键词会列出所有分类。",
      {
        query: { type: "string", description: "关键词,如「群 禁言」「转发」「文件」,可空" },
        tag: { type: "string", description: "按分类筛选,如「群组接口」「文件扩展」,可空" },
      },
      [],
      (a) => {
        const query = String(a.query ?? "").trim();
        const tag = String(a.tag ?? "").trim() || undefined;
        const all = catalog();
        if (!query && !tag) {
          const counts = new Map<string, number>();
          for (const e of all) for (const t of e.tags.length ? e.tags : ["其他"]) counts.set(t, (counts.get(t) ?? 0) + 1);
          return `共 ${all.length} 个接口。分类:\n${[...counts].map(([t, n]) => `- ${t}(${n})`).join("\n")}\n用 query 或 tag 再搜。`;
        }
        const hits = searchCatalog(all, query, tag).filter((e) => !DENIED_ACTIONS.has(e.action));
        if (!hits.length) return "没有找到相关接口,换个关键词试试";
        const shown = hits.slice(0, 25).map(formatEntry).join("\n");
        return `${shown}${hits.length > 25 ? `\n…还有 ${hits.length - 25} 个,请加关键词缩小范围` : ""}\n(参数名后带 * 的是必填)`;
      },
    ),
    defineTool(
      "qq_api",
      "调用任意一个 NapCat 的 QQ 接口。先用 qq_api_search 找到接口名和参数。破坏性的操作(踢人、禁言、退群、删好友、撤回他人消息、解散群)要有明确理由。",
      {
        action: { type: "string", description: "接口名,如 get_group_msg_history" },
        params: { type: "object", description: "参数对象,如 {\"group_id\": \"123\"}" },
      },
      ["action"],
      async (a) => {
        const action = String(a.action ?? "").trim().replace(/^\./, "");
        if (!/^[a-z0-9_]+$/i.test(action)) return "接口名不合法";
        if (DENIED_ACTIONS.has(action)) return `接口 ${action} 不对你开放(涉及登录凭证或会让 QQ 退出)`;
        const params = (a.params && typeof a.params === "object" ? a.params : {}) as Record<string, unknown>;
        const entry = catalog().find((e) => e.action === action);
        if (entry) {
          const missing = entry.params.filter((p) => p.required && params[p.name] === undefined).map((p) => p.name);
          if (missing.length) return `缺少必填参数: ${missing.join(", ")}\n${formatEntry(entry)}`;
        }
        const data = await d.call(action, params);
        return show(data);
      },
    ),
    defineTool(
      "group_overview",
      "查看一个群的概况:群名、人数/上限,以及成员列表(QQ号、昵称、群名片、角色、最后发言时间)。人多时只列管理员和最近活跃的人。",
      { group_id: { type: "number" } },
      ["group_id"],
      async (a) => {
        const group_id = String(a.group_id);
        const [info, members] = (await Promise.all([d.call("get_group_info", { group_id }), d.call("get_group_member_list", { group_id })])) as [
          Record<string, any> | null,
          Array<Record<string, any>> | null,
        ];
        const list = members ?? [];
        const head = `群「${info?.group_name ?? group_id}」(${group_id}) 成员 ${info?.member_count ?? list.length}/${info?.max_member_count ?? "?"}`;
        const line = (m: Record<string, any>) =>
          `${m.user_id} ${m.card || m.nickname || ""}${m.card && m.nickname ? `(${m.nickname})` : ""} [${ROLE[m.role] ?? m.role}]${m.title ? ` 头衔:${m.title}` : ""} 最后发言:${when(m.last_sent_time)}`;
        if (list.length <= 50) return [head, ...list.map(line)].join("\n");
        const staff = list.filter((m) => m.role !== "member");
        const recent = list.filter((m) => m.role === "member").sort((x, y) => Number(y.last_sent_time) - Number(x.last_sent_time)).slice(0, 30);
        return [head, `人数较多,只列群主/管理员和最近活跃的 30 人(要完整名单请用 qq_api 的 get_group_member_list):`, ...staff.map(line), "--", ...recent.map(line)].join("\n");
      },
    ),
    defineTool(
      "user_profile",
      "查看某个 QQ 号的资料(昵称、性别、年龄、等级、签名、地区等);给 group_id 时还会带上他在那个群里的信息(群名片、角色、入群时间、最后发言)。",
      { user_id: { type: "number" }, group_id: { type: "number", description: "可选,同时查他在这个群的信息" } },
      ["user_id"],
      async (a) => {
        const user_id = String(a.user_id);
        const out: string[] = [`== QQ ${user_id} 的资料 ==`, scalars((await d.call("get_stranger_info", { user_id, no_cache: true })) as Record<string, unknown>)];
        if (a.group_id) {
          const m = (await d.call("get_group_member_info", { group_id: String(a.group_id), user_id, no_cache: true })) as Record<string, any> | null;
          out.push(`== 在群 ${a.group_id} 的信息 ==`, m ? `${line(m)}\n${scalars(m, ["last_sent_time", "join_time"])}` : "(不在这个群里)");
        }
        return out.join("\n");

        function line(m: Record<string, any>): string {
          return `角色: ${ROLE[m.role] ?? m.role}  入群: ${when(m.join_time)}  最后发言: ${when(m.last_sent_time)}`;
        }
      },
    ),
    defineTool(
      "handle_friend_request",
      "同意或拒绝一个好友请求。flag 在收到请求的通知里。",
      { flag: { type: "string" }, approve: { type: "boolean" }, remark: { type: "string", description: "同意时给对方设置的备注,可空" } },
      ["flag", "approve"],
      async (a) => {
        await d.call("set_friend_add_request", { flag: String(a.flag), approve: !!a.approve, ...(a.remark ? { remark: String(a.remark) } : {}) });
        return a.approve ? "已同意好友请求" : "已拒绝好友请求";
      },
    ),
    defineTool(
      "handle_group_request",
      "同意或拒绝一个入群请求,包括别人邀请你进群,以及别人申请加入你管理的群。flag 在收到请求的通知里。",
      { flag: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string", description: "拒绝理由,可空" } },
      ["flag", "approve"],
      async (a) => {
        await d.call("set_group_add_request", { flag: String(a.flag), approve: !!a.approve, ...(a.reason ? { reason: String(a.reason) } : {}) });
        return a.approve ? "已同意入群请求" : "已拒绝入群请求";
      },
    ),
  ];
}

export function qqApiPromptSection(count: number): string {
  return [
    "# QQ 全部接口",
    `除了上面这些常用工具,你还能通过 qq_api 调用 NapCat 提供的全部 ${count} 个 QQ 接口,先用 qq_api_search 按关键词找接口名和参数。例如:`,
    "- 看更早的聊天记录:get_group_msg_history / get_friend_msg_history;展开别人发的合并转发:get_forward_msg(用消息里的 id);语音转文字:fetch_ptt_text;识别图里的文字:ocr_image",
    "- 群管理:设置群名片 set_group_card、禁言 set_group_ban、踢人 set_group_kick、设精华 set_essence_msg、群公告、群相册、群文件(upload_group_file)、退群 set_group_leave",
    "- 发特殊内容:用 qq_api 的 send_group_msg / send_private_msg 直接发消息段(语音、文件、音乐卡片、合并转发等);send_group_ai_record 能让 AI 用语音说话",
    "- 好友:改备注、删好友、看好友列表、点赞、看陌生人资料",
    "破坏性的操作(踢人、禁言、退群、删好友、解散群)要有明确的理由,拿不准就先问管理员。",
    "聊天记录里形如 [合并转发 id=…]、[语音 file=… 消息#…]、[文件:名字 file=…] 的占位符里带着调用这些接口需要的 id。",
  ].join("\n");
}
