import { defineTool, type Tool } from "../agent/tools";
import type { MediaStore } from "../media/store";
import { parseSpace } from "../napcat/types";

export interface AccountDeps {
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
  store: MediaStore;
}

/** 在线状态对应的 NapCat status 值 */
const ONLINE_STATUS: Record<string, number> = { online: 10, away: 30, invisible: 40, busy: 50, q_me: 60, dnd: 70 };
const VISIBILITY: Record<string, number> = { public: 1, friends: 4, self: 64 };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 管理 QQ 号本身:资料、头像、签名、空间动态、在线状态,以及点赞、戳一戳、表情回应 */
export function accountTools(d: AccountDeps): Tool[] {
  const imagePath = (id: unknown): string => {
    const m = d.store.get(Number(id));
    if (!m) throw new Error(`图库里没有编号 ${id}`);
    if (m.kind === "video") throw new Error(`#${m.id} 是视频,这里需要图片`);
    return `file://${d.store.absPath(m)}`;
  };

  return [
    defineTool(
      "set_signature",
      "修改这个 QQ 号的个性签名。别频繁改,内容要符合你的人设。",
      { text: { type: "string", description: "新的签名" } },
      ["text"],
      async (a) => {
        const text = str(a.text);
        if (!text) return "签名不能为空";
        await d.call("set_self_longnick", { longNick: text });
        return "签名已修改";
      },
    ),
    defineTool(
      "set_nickname",
      "修改这个 QQ 号的昵称。",
      { nickname: { type: "string" } },
      ["nickname"],
      async (a) => {
        const nickname = str(a.nickname);
        if (!nickname) return "昵称不能为空";
        await d.call("set_qq_profile", { nickname });
        return "昵称已修改";
      },
    ),
    defineTool(
      "set_avatar",
      "修改这个 QQ 号的头像。可以用图库里的图片编号,也可以给文件路径或 http(s) 链接。",
      {
        media_id: { type: "number", description: "图库里的图片编号" },
        file: { type: "string", description: "文件路径或 http(s) 链接(没有 media_id 时用)" },
      },
      [],
      async (a) => {
        const file = a.media_id != null ? imagePath(a.media_id) : str(a.file);
        if (!file) return "需要 media_id 或 file";
        await d.call("set_qq_avatar", { file });
        return "头像已修改";
      },
    ),
    defineTool(
      "post_qzone",
      "在 QQ 空间发一条动态(说说),可带图。图片用图库里的编号。",
      {
        content: { type: "string", description: "正文" },
        media_ids: { type: "array", items: { type: "number" }, description: "图库图片编号,最多 9 张" },
        visibility: { type: "string", enum: Object.keys(VISIBILITY), description: "public 所有人 / friends 仅好友 / self 仅自己,默认 public" },
      },
      ["content"],
      async (a) => {
        const content = str(a.content);
        if (!content) return "正文不能为空";
        const ids = Array.isArray(a.media_ids) ? a.media_ids.slice(0, 9) : [];
        const right = VISIBILITY[str(a.visibility) || "public"];
        if (!right) return "visibility 不合法";
        const res = (await d.call("send_qzone_msg", { content, images: ids.map(imagePath), ugc_right: right })) as { tid?: string } | null;
        return `动态已发布,tid=${res?.tid ?? "未知"}`;
      },
    ),
    defineTool(
      "delete_qzone",
      "删除一条自己发的 QQ 空间动态。",
      { tid: { type: "string", description: "发布动态时返回的 tid" } },
      ["tid"],
      async (a) => {
        await d.call("delete_qzone_msg", { tid: str(a.tid) });
        return "已删除";
      },
    ),
    defineTool(
      "set_online_status",
      "修改在线状态。",
      { status: { type: "string", enum: Object.keys(ONLINE_STATUS), description: "online 在线 / away 离开 / invisible 隐身 / busy 忙碌 / q_me Q我吧 / dnd 请勿打扰" } },
      ["status"],
      async (a) => {
        const s = ONLINE_STATUS[str(a.status)];
        if (s === undefined) return "status 不合法";
        await d.call("set_online_status", { status: s, ext_status: 0, battery_status: 0 });
        return "在线状态已修改";
      },
    ),
    defineTool(
      "send_like",
      "给某人的资料卡点赞(每天对同一个人有次数上限)",
      { user_id: { type: "number" }, times: { type: "number", description: "1 到 10,默认 1" } },
      ["user_id"],
      async (a) => {
        const times = Math.min(Math.max(Number(a.times) || 1, 1), 10);
        await d.call("send_like", { user_id: String(a.user_id), times });
        return `已点赞 ${times} 次`;
      },
    ),
    defineTool(
      "poke",
      "戳一戳某人。在群里聊天时默认是群内戳,私聊里是私聊戳;自由时间想戳群里的人要给 group_id。",
      { user_id: { type: "number" }, group_id: { type: "number", description: "可选,在这个群里戳" } },
      ["user_id"],
      async (a, ctx) => {
        const sp = /^[gp]:\d+$/.test(ctx.space) ? parseSpace(ctx.space) : null;
        const group = a.group_id ? String(a.group_id) : sp?.type === "group" ? String(sp.id) : undefined;
        await d.call("send_poke", { user_id: String(a.user_id), ...(group ? { group_id: group } : {}) });
        return "已戳";
      },
    ),
    defineTool(
      "react_to_message",
      "给某条消息贴一个表情回应(类似点表情)",
      { message_id: { type: "number", description: "消息 ID,即聊天记录里 # 后面的数字" }, emoji_id: { type: "number", description: "QQ 表情编号,例如 76 是赞,66 是爱心" } },
      ["message_id", "emoji_id"],
      async (a) => {
        await d.call("set_msg_emoji_like", { message_id: Number(a.message_id), emoji_id: Number(a.emoji_id), set: true });
        return "已回应";
      },
    ),
  ];
}

export function accountPromptSection(): string {
  return [
    "# 管理自己的 QQ 号",
    "你可以改自己账号的资料,也可以发动态:set_nickname 改昵称、set_signature 改签名、set_avatar 换头像、post_qzone 发 QQ 空间动态(可带图库里的图)、set_online_status 改在线状态。",
    "这是你自己的账号,这些你可以按需要做,也可以在自由时间自己想做就做(比如心情好发一条动态、换个签名)。但这些改动都会被别人看到:别太频繁,要符合你的人设;别人让你做时,觉得合理就做,内容没说清楚可以先问;换头像、发动态之前先想想有没有合适的图。",
    "发了动态、改了签名这类事,用 remember 记一笔(subject 写 global),下次自由时间才知道自己最近做过什么,不会重复。",
    "点赞(send_like)、戳一戳(poke)、给消息贴表情(react_to_message)是轻量互动,聊天时觉得合适可以自己用,但别刷屏。",
  ].join("\n");
}
