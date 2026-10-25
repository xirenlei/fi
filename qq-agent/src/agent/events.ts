import type { OneBotEvent } from "../napcat/types";

export type RequestMode = "agent" | "notify" | "reject";

export type EventAction =
  /** 好友请求、入群邀请等:需要有人处理 */
  | { type: "request"; kind: "friend" | "group"; flag: string; text: string; fromAdmin: boolean; reject: () => { action: string; params: Record<string, unknown> } }
  /** 发生了一件事,交给自由时间的上下文让模型自己决定 */
  | { type: "wander"; text: string }
  /** 在某个会话里记一笔系统消息,并按 trigger 决定要不要让模型接话 */
  | { type: "note"; space: string; senderId: number; text: string; trigger: "mention" | "judge" | "none" };

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** 把 OneBot 的请求和通知事件翻译成 Agent 能处理的动作,不认识的返回 null */
export function interpretEvent(ev: OneBotEvent, selfId: number | undefined, admins: number[]): EventAction | null {
  const e = ev as Record<string, any>;
  if (ev.post_type === "request") {
    const user = Number(e.user_id);
    const comment = str(e.comment).trim();
    const fromAdmin = admins.includes(user);
    if (e.request_type === "friend") {
      return {
        type: "request",
        kind: "friend",
        flag: str(e.flag),
        fromAdmin,
        text: `[好友请求] QQ ${user}${fromAdmin ? "(管理员)" : ""} 想加你为好友,验证消息:「${comment || "无"}」\nflag=${str(e.flag)}`,
        reject: () => ({ action: "set_friend_add_request", params: { flag: str(e.flag), approve: false } }),
      };
    }
    if (e.request_type === "group") {
      const invite = e.sub_type === "invite";
      return {
        type: "request",
        kind: "group",
        flag: str(e.flag),
        fromAdmin,
        text: invite
          ? `[入群邀请] QQ ${user}${fromAdmin ? "(管理员)" : ""} 邀请你加入群 ${e.group_id}\nflag=${str(e.flag)}`
          : `[入群申请] QQ ${user}${fromAdmin ? "(管理员)" : ""} 申请加入你管理的群 ${e.group_id},验证消息:「${comment || "无"}」\nflag=${str(e.flag)}`,
        reject: () => ({ action: "set_group_add_request", params: { flag: str(e.flag), approve: false, reason: "暂不接受" } }),
      };
    }
    return null;
  }

  if (ev.post_type !== "notice") return null;
  const user = Number(e.user_id);
  const group = e.group_id !== undefined ? Number(e.group_id) : undefined;
  switch (e.notice_type) {
    case "notify":
      if (e.sub_type === "poke" && selfId !== undefined && Number(e.target_id) === selfId) {
        return {
          type: "note",
          space: group ? `g:${group}` : `p:${user}`,
          senderId: user,
          text: `[QQ ${user} 戳了你一下]`,
          trigger: "mention",
        };
      }
      return null;
    case "group_increase":
      if (selfId !== undefined && user === selfId) {
        return { type: "wander", text: `[你加入了群 ${group}] 通过${e.sub_type === "invite" ? "邀请" : "审核"}进群。可以看看群里有什么人(group_overview),并礼貌地打个招呼。` };
      }
      return { type: "note", space: `g:${group}`, senderId: user, text: `[系统] QQ ${user} 加入了群`, trigger: "judge" };
    case "group_decrease":
      return { type: "note", space: `g:${group}`, senderId: user, text: `[系统] QQ ${user} ${e.sub_type === "kick" || e.sub_type === "kick_me" ? "被移出" : "退出"}了群`, trigger: "none" };
    case "friend_add":
      return { type: "wander", text: `[你和 QQ ${user} 成为了好友] 可以主动打个招呼。` };
    default:
      return null;
  }
}

/** 给处理请求的模型附带的行动指引 */
export function requestGuidance(mode: RequestMode, fromAdmin: boolean): string {
  if (mode === "notify") return "(设置为只通知:不要自己同意或拒绝。请把这个请求的内容和 flag 私聊告诉管理员,等管理员回复后再用 handle_friend_request / handle_group_request 处理。)";
  return fromAdmin
    ? "(发起人是管理员,可以直接同意,处理完告诉管理员一声。)"
    : "(自己判断:正常的人且有合理的验证消息就同意;广告、陌生人批量拉群、可疑的就拒绝;拿不准就私聊问管理员。用 handle_friend_request / handle_group_request 处理,处理完如实告诉管理员结果。)";
}
