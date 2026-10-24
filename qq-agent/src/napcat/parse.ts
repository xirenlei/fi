import type { MessageEvent, Segment } from "./types";

export interface MediaRef {
  kind: "image" | "video" | "record" | "file";
  /** NapCat 提供的临时下载地址或本地路径 */
  url?: string;
  file?: string;
  /** 是否为表情包(QQ 里的「动画表情」) */
  isSticker?: boolean;
}

export interface ParsedMessage {
  /** 供模型阅读的文本,图片等用占位符表示 */
  text: string;
  media: MediaRef[];
  mentionsSelf: boolean;
  mentionsAll: boolean;
  replyToId?: number;
}

export function parseMessage(ev: Pick<MessageEvent, "message" | "self_id">): ParsedMessage {
  const parts: string[] = [];
  const media: MediaRef[] = [];
  let mentionsSelf = false;
  let mentionsAll = false;
  let replyToId: number | undefined;

  for (const seg of ev.message ?? []) {
    const d = seg.data as Record<string, string | number | undefined>;
    switch (seg.type) {
      case "text":
        parts.push(String(d.text ?? ""));
        break;
      case "at":
        if (d.qq === "all") {
          mentionsAll = true;
          parts.push("@全体成员");
        } else {
          if (String(d.qq) === String(ev.self_id)) mentionsSelf = true;
          parts.push(`@${d.qq}`);
        }
        break;
      case "reply":
        replyToId = Number(d.id);
        break;
      case "image": {
        // sub_type 1 为表情包,0 为普通图片
        const isSticker = Number(d.sub_type) === 1;
        media.push({ kind: "image", url: asStr(d.url), file: asStr(d.file), isSticker });
        parts.push(isSticker ? "[表情包]" : "[图片]");
        break;
      }
      case "video":
        media.push({ kind: "video", url: asStr(d.url), file: asStr(d.file) });
        parts.push("[视频]");
        break;
      case "record":
        media.push({ kind: "record", url: asStr(d.url), file: asStr(d.file) });
        parts.push("[语音]");
        break;
      case "file":
        media.push({ kind: "file", url: asStr(d.url), file: asStr(d.file) });
        parts.push(`[文件:${d.name ?? d.file ?? ""}]`);
        break;
      case "face":
        parts.push(`[QQ表情:${d.id}]`);
        break;
      default:
        parts.push(`[${seg.type}]`);
    }
  }

  return { text: parts.join("").trim(), media, mentionsSelf, mentionsAll, replyToId };
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function displayName(ev: Pick<MessageEvent, "sender" | "user_id">): string {
  return ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
}

/** 构造消息段的小工具 */
export const seg = {
  text: (text: string): Segment => ({ type: "text", data: { text } }),
  at: (qq: number | string): Segment => ({ type: "at", data: { qq: String(qq) } }),
  reply: (id: number | string): Segment => ({ type: "reply", data: { id: String(id) } }),
  image: (file: string): Segment => ({ type: "image", data: { file } }),
  video: (file: string): Segment => ({ type: "video", data: { file } }),
};
