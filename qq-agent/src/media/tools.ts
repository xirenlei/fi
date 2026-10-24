import { defineTool, type Tool } from "../agent/tools";
import type { MediaItem, MediaKind, MediaStore } from "./store";

const fmt = (m: MediaItem) => `#${m.id} [${m.kind}${m.animated ? "/动" : ""}] ${m.summary} — ${m.file}`;
const kindOf = (v: unknown): MediaKind | undefined => (v === "image" || v === "sticker" || v === "video" ? v : undefined);

export function mediaTools(store: MediaStore): Tool[] {
  const kindProp = { type: "string", enum: ["image", "sticker", "video"], description: "可选,限定类别" };
  return [
    defineTool(
      "media_search",
      "在图库中按关键词搜索图片、表情包和视频(匹配摘要、描述和标签),找合适的表情包时用",
      { query: { type: "string", description: "空格分隔的关键词,如「无语 嘲讽」" }, kind: kindProp },
      ["query"],
      (a) => {
        const rows = store.search(String(a.query ?? ""), { kind: kindOf(a.kind), limit: 15 });
        return rows.length ? rows.map(fmt).join("\n") : "图库里没有匹配的内容";
      },
    ),
    defineTool(
      "media_list",
      "列出图库里最新的内容,相当于翻看图库目录",
      { kind: kindProp, limit: { type: "number", description: "默认 30" } },
      [],
      (a) => {
        const rows = store.list({ kind: kindOf(a.kind), limit: Math.min(Number(a.limit) || 30, 100) });
        return rows.length ? rows.map(fmt).join("\n") : "图库是空的";
      },
    ),
    defineTool("media_info", "查看图库中某一项的完整描述和标签", { id: { type: "number" } }, ["id"], (a) => {
      const m = store.get(Number(a.id));
      if (!m) return "没有这个编号";
      return [fmt(m), `描述:${m.detail || "(无)"}`, `标签:${m.tags.join("、") || "(无)"}`, `大小:${m.size} 字节`].join("\n");
    }),
    defineTool(
      "media_set_kind",
      "修改图库条目的类别,例如把一张有趣的图片收藏为表情包(sticker)",
      { id: { type: "number" }, kind: { type: "string", enum: ["image", "sticker", "video"] } },
      ["id", "kind"],
      (a) => {
        const k = kindOf(a.kind);
        if (!k) return "kind 不合法";
        const m = store.get(Number(a.id));
        if (!m) return "没有这个编号";
        if ((m.kind === "video") !== (k === "video")) return "视频和图片不能互相转换";
        return `已改为 ${store.setKind(m.id, k)!.kind}`;
      },
    ),
    defineTool("media_delete", "从图库删除一项", { id: { type: "number" } }, ["id"], (a) =>
      store.remove(Number(a.id)) ? "已删除" : "没有这个编号",
    ),
  ];
}
