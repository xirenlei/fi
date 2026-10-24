import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../memory/db";
import { safeName } from "./detect";

export type MediaKind = "image" | "sticker" | "video";

export interface MediaItem {
  id: number;
  kind: MediaKind;
  file: string;
  mime: string;
  sha256: string;
  summary: string;
  detail: string;
  tags: string[];
  animated: boolean;
  size: number;
  ts: number;
  sourceSpace: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  file         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  sha256       TEXT NOT NULL UNIQUE,
  summary      TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',
  animated     INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  source_space TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, id);
`;

const COLS = `id, kind, file, mime, sha256, summary, detail, tags, animated, size, ts, source_space AS sourceSpace`;

function hydrate(r: any): MediaItem {
  return { ...r, tags: JSON.parse(r.tags), animated: !!r.animated };
}

export function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** 图库:文件放在 dir 下按类别分目录,索引放 SQLite */
export class MediaStore {
  constructor(
    private db: Db,
    readonly dir: string,
  ) {
    db.raw.exec(SCHEMA);
    for (const k of ["image", "sticker", "video"]) mkdirSync(join(dir, k), { recursive: true });
  }

  findByHash(sha: string): MediaItem | null {
    const r = this.db.raw.query(`SELECT ${COLS} FROM media WHERE sha256 = $sha`).get({ $sha: sha });
    return r ? hydrate(r) : null;
  }

  get(id: number): MediaItem | null {
    const r = this.db.raw.query(`SELECT ${COLS} FROM media WHERE id = $id`).get({ $id: id });
    return r ? hydrate(r) : null;
  }

  absPath(item: MediaItem): string {
    return join(this.dir, item.file);
  }

  read(item: MediaItem): Uint8Array {
    return readFileSync(this.absPath(item));
  }

  add(input: {
    kind: MediaKind;
    data: Uint8Array;
    ext: string;
    mime: string;
    summary: string;
    detail?: string;
    tags?: string[];
    animated?: boolean;
    sourceSpace?: string;
  }): MediaItem {
    const sha = sha256Hex(input.data);
    const existing = this.findByHash(sha);
    if (existing) return existing;
    const name = `${safeName(input.summary)}_${sha.slice(0, 8)}.${input.ext}`;
    const rel = join(input.kind, name);
    writeFileSync(join(this.dir, rel), input.data);
    const r = this.db.raw
      .query(
        `INSERT INTO media (kind, file, mime, sha256, summary, detail, tags, animated, size, ts, source_space)
         VALUES ($kind, $file, $mime, $sha, $summary, $detail, $tags, $animated, $size, $ts, $space)`,
      )
      .run({
        $kind: input.kind,
        $file: rel,
        $mime: input.mime,
        $sha: sha,
        $summary: input.summary,
        $detail: input.detail ?? "",
        $tags: JSON.stringify(input.tags ?? []),
        $animated: input.animated ? 1 : 0,
        $size: input.data.length,
        $ts: Math.floor(Date.now() / 1000),
        $space: input.sourceSpace ?? "",
      });
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** 在图库中按关键词搜索摘要、描述和标签 */
  search(query: string, opts: { kind?: MediaKind; limit?: number } = {}): MediaItem[] {
    const words = query.split(/\s+/).filter(Boolean);
    const rows = this.list({ kind: opts.kind, limit: 500 });
    if (!words.length) return rows.slice(0, opts.limit ?? 20);
    const score = (m: MediaItem) => {
      const hay = `${m.summary} ${m.detail} ${m.tags.join(" ")}`.toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w.toLowerCase()) ? 1 : 0), 0);
    };
    return rows
      .map((m) => ({ m, s: score(m) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.m.id - a.m.id)
      .slice(0, opts.limit ?? 20)
      .map((x) => x.m);
  }

  list(opts: { kind?: MediaKind; limit?: number } = {}): MediaItem[] {
    const rows = this.db.raw
      .query(`SELECT ${COLS} FROM media WHERE ($kind IS NULL OR kind = $kind) ORDER BY id DESC LIMIT $limit`)
      .all({ $kind: opts.kind ?? null, $limit: opts.limit ?? 30 });
    return rows.map(hydrate);
  }

  /** 改类别(例如把普通图片收藏为表情包),文件同步搬到对应目录 */
  setKind(id: number, kind: MediaKind): MediaItem | null {
    const item = this.get(id);
    if (!item) return null;
    if (item.kind === kind) return item;
    const rel = join(kind, item.file.split("/").pop()!);
    writeFileSync(join(this.dir, rel), this.read(item));
    unlinkSync(this.absPath(item));
    this.db.raw.query("UPDATE media SET kind = $kind, file = $file WHERE id = $id").run({ $kind: kind, $file: rel, $id: id });
    return this.get(id);
  }

  remove(id: number): boolean {
    const item = this.get(id);
    if (!item) return false;
    if (existsSync(this.absPath(item))) unlinkSync(this.absPath(item));
    this.db.raw.query("DELETE FROM media WHERE id = $id").run({ $id: id });
    return true;
  }
}
