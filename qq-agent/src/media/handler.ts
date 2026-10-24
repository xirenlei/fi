import { existsSync, readFileSync } from "node:fs";
import type { MediaHandler } from "../agent/agent";
import type { Config } from "../config";
import type { LlmClient } from "../llm/client";
import type { MediaRef } from "../napcat/parse";
import type { Segment } from "../napcat/types";
import { detectMedia } from "./detect";
import { describeMedia } from "./describe";
import { defaultExec, extractFrames, hasFfmpeg, shrinkImage, type Exec } from "./ffmpeg";
import { MediaStore, sha256Hex, type MediaItem } from "./store";

const MAX_BYTES = 100 * 1024 * 1024;
const RAW_IMAGE_LIMIT = 4 * 1024 * 1024;

export type FetchBytes = (ref: MediaRef) => Promise<Uint8Array>;

export const defaultFetch: FetchBytes = async (ref) => {
  const src = ref.url ?? ref.file;
  if (!src) throw new Error("no media source");
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error("media too large");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("media too large");
    return buf;
  }
  const path = src.replace(/^file:\/\//, "");
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  return new Uint8Array(readFileSync(path));
};

const toDataUrl = (data: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(data).toString("base64")}`;

function kindName(m: MediaItem): string {
  if (m.kind === "sticker") return "表情包";
  if (m.kind === "video") return "视频";
  return m.animated ? "动图" : "图片";
}

export function labelOf(m: MediaItem): string {
  return `[${kindName(m)}#${m.id}:${m.summary}]`;
}

export interface PipelineDeps {
  store: MediaStore;
  llm: LlmClient;
  cfg: () => Config;
  fetchBytes?: FetchBytes;
  exec?: Exec;
  log?: (m: string) => void;
}

/** 图片、动图、表情包、视频的入库、索引和发送 */
export class MediaPipeline implements MediaHandler {
  private ffmpeg?: boolean;

  constructor(private d: PipelineDeps) {}

  private log(m: string) {
    (this.d.log ?? console.log)(`[media] ${m}`);
  }

  private async canFfmpeg(): Promise<boolean> {
    this.ffmpeg ??= await hasFfmpeg(this.d.exec ?? defaultExec);
    return this.ffmpeg;
  }

  async ingest(parsed: { text: string; media: MediaRef[] }, space: string) {
    const labels: string[] = [];
    const images: string[] = [];
    for (const ref of parsed.media) {
      if (ref.kind !== "image" && ref.kind !== "video") continue;
      try {
        const r = await this.processOne(ref, space);
        labels.push(labelOf(r.item));
        images.push(...r.images);
      } catch (e) {
        this.log(`failed to process ${ref.kind}: ${e}`);
        labels.push(ref.kind === "video" ? "[视频:读取失败]" : "[图片:读取失败]");
      }
    }
    let i = 0;
    const text = parsed.text.replace(/\[(?:图片|表情包|视频)\]/g, (orig) => labels[i++] ?? orig);
    return { text, images };
  }

  private async processOne(ref: MediaRef, space: string): Promise<{ item: MediaItem; images: string[] }> {
    const fetchBytes = this.d.fetchBytes ?? defaultFetch;
    const data = await fetchBytes(ref);
    const det = detectMedia(data);
    if (!det) throw new Error("unrecognized media format");
    const existing = this.d.store.findByHash(sha256Hex(data));
    if (existing) return { item: existing, images: [] };

    const exec = this.d.exec ?? defaultExec;
    const ff = await this.canFfmpeg();
    let frames: string[] = [];
    if (det.kind === "video") {
      if (ff) frames = (await extractFrames(data, det.ext, 4, 640, exec)).map((f) => toDataUrl(f, "image/jpeg"));
    } else if (det.animated) {
      if (ff) frames = (await extractFrames(data, det.ext, 3, 512, exec)).map((f) => toDataUrl(f, "image/jpeg"));
    } else {
      const small = ff ? await shrinkImage(data, det.ext, 1024, exec) : null;
      if (small) frames = [toDataUrl(small, "image/jpeg")];
      else if (data.length <= RAW_IMAGE_LIMIT) frames = [toDataUrl(data, det.mime)];
    }

    const what =
      det.kind === "video" ? "一段视频中均匀抽取的几帧" : det.animated ? "一张动图中抽取的几帧" : ref.isSticker ? "一张聊天表情包" : "一张图片";
    let desc = { summary: "未识别", detail: "", tags: [] as string[] };
    try {
      desc = await describeMedia(this.d.llm, this.d.cfg().llm.lightModel, what, frames);
    } catch (e) {
      this.log(`describe failed: ${e}`);
    }
    const kind = det.kind === "video" ? "video" : ref.isSticker ? "sticker" : "image";
    const item = this.d.store.add({ kind, data, ext: det.ext, mime: det.mime, animated: det.animated, sourceSpace: space, ...desc });
    return { item, images: frames };
  }

  async resolveOut(part: { kind: "sticker" | "image" | "video"; ref: string }): Promise<{ segment: Segment; label: string } | null> {
    const id = Number(part.ref);
    let item = Number.isInteger(id) ? this.d.store.get(id) : null;
    if (!item) item = this.d.store.search(part.ref, { limit: 1 })[0] ?? null;
    if (!item) {
      this.log(`media not found: ${part.ref}`);
      return null;
    }
    if ((part.kind === "video") !== (item.kind === "video")) {
      this.log(`media #${item.id} is a ${item.kind}, not usable as <${part.kind}>`);
      return null;
    }
    const file = `file://${this.d.store.absPath(item)}`;
    const segment: Segment =
      item.kind === "video"
        ? { type: "video", data: { file } }
        : { type: "image", data: item.kind === "sticker" ? { file, sub_type: 1 } : { file } };
    return { segment, label: labelOf(item) };
  }

  promptSection(): string {
    return [
      "# 图片、表情包和视频",
      "别人发来的图片、动图、表情包和视频会自动存进图库,并在聊天记录里显示为 [表情包#12:摘要]、[图片#13:摘要]、[视频#14:摘要] 的形式,# 后面是图库编号。",
      "图片只在刚收到的那一轮让你直接看到,之后只剩摘要。需要更多细节可以用 media_info 看完整描述。",
      '发送图库里的东西:在 <msg> 里写 <sticker id="12"/>(表情包)、<image id="13"/>(图片)、<video id="14"/>(视频),每个媒体单独放一条 <msg> 更自然。',
      "想发表情包时,先用 media_search 按情绪或内容搜,再用编号发送;图库里没有合适的就不要硬发。",
      "别人发来的有趣图片可以用 media_set_kind 收藏成表情包;不想要的用 media_delete 删掉。",
    ].join("\n");
  }
}
