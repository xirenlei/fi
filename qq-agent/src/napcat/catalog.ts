import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config";
import type { CatalogEntry } from "../../scripts/gen-napcat-catalog";

export type { CatalogEntry };

/**
 * NapCat 全部接口的说明。优先用安装时从已装 NapCat 里重新生成的(和实际版本一致),
 * 没有就用随代码打包的这一份。
 */
export function loadCatalog(): CatalogEntry[] {
  const local = join(dataDir(), "napcat-catalog.json");
  const path = existsSync(local) ? local : join(import.meta.dir, "catalog.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CatalogEntry[];
  } catch {
    return [];
  }
}

export function formatEntry(e: CatalogEntry): string {
  const params = e.params.map((p) => `${p.name}${p.required ? "*" : ""}(${p.type}${p.description ? ` ${p.description}` : ""})`).join(", ");
  return `${e.action} — ${e.summary || e.description || "(无说明)"}${params ? `\n    参数: ${params}` : ""}`;
}

/** 按关键词搜索:匹配接口名、说明、参数名,接口名命中权重最高 */
export function searchCatalog(catalog: CatalogEntry[], query: string, tag?: string): CatalogEntry[] {
  const words = query.toLowerCase().split(/[\s,，]+/).filter(Boolean);
  const pool = tag ? catalog.filter((e) => e.tags.some((t) => t.includes(tag))) : catalog;
  if (!words.length) return pool;
  return pool
    .map((e) => {
      let score = 0;
      for (const w of words) {
        if (e.action.includes(w)) score += 5;
        if (e.summary.toLowerCase().includes(w)) score += 3;
        if (e.description.toLowerCase().includes(w)) score += 2;
        if (e.params.some((p) => p.name.includes(w) || p.description.toLowerCase().includes(w))) score += 1;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.action.localeCompare(b.e.action))
    .map((x) => x.e);
}
