/** OneBot 11 消息段 */
export type Segment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file?: string; url?: string; summary?: string; sub_type?: number } }
  | { type: "face"; data: { id: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "video"; data: { file?: string; url?: string } }
  | { type: "record"; data: { file?: string; url?: string } }
  | { type: "file"; data: { file?: string; name?: string; url?: string } }
  | { type: string; data: Record<string, unknown> };

export interface MessageEvent {
  post_type: "message" | "message_sent";
  message_type: "private" | "group";
  message_id: number;
  user_id: number;
  group_id?: number;
  self_id: number;
  time: number;
  message: Segment[];
  raw_message?: string;
  sender?: { user_id?: number; nickname?: string; card?: string };
}

export interface OneBotEvent {
  post_type: string;
  self_id?: number;
  [k: string]: unknown;
}

export interface ActionResponse<T = unknown> {
  status: "ok" | "failed" | "async";
  retcode: number;
  data: T;
  message?: string;
  echo?: string;
}

/** 一个聊天空间:一个群或一个私聊 */
export type SpaceId = `g:${number}` | `p:${number}`;

export function spaceOf(ev: Pick<MessageEvent, "message_type" | "group_id" | "user_id">): SpaceId {
  return ev.message_type === "group" ? `g:${ev.group_id ?? 0}` : `p:${ev.user_id}`;
}

export function parseSpace(space: string): { type: "group" | "private"; id: number } {
  const [kind, id] = space.split(":");
  const n = Number(id);
  if ((kind !== "g" && kind !== "p") || !Number.isInteger(n)) throw new Error(`bad space id: ${space}`);
  return { type: kind === "g" ? "group" : "private", id: n };
}
