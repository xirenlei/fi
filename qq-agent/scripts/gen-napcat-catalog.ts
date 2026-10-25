// 从 NapCat 的 napcat.mjs 里抽取全部动作(接口)的说明与参数,生成 src/napcat/catalog.json。
// 用法: bun run scripts/gen-napcat-catalog.ts <napcat.mjs 路径> [输出路径]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}
export interface CatalogEntry {
  action: string;
  summary: string;
  description: string;
  tags: string[];
  params: CatalogParam[];
}

/** 从 start 位置的左括号开始,返回配对的右括号之后的位置 */
function balanced(src: string, start: number): number {
  const open = src[start];
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced ${open} at ${start}`);
}

/** 按顶层逗号切分 */
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) {
      cur += c;
      if (c === "\\") cur += body[++i] ?? "";
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      cur += c;
    } else if ("({[".includes(c)) {
      depth++;
      cur += c;
    } else if (")}]".includes(c)) {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function str(re: RegExp, text: string): string {
  const m = text.match(re);
  return m ? m[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n") : "";
}

function parseSchema(src: string, name: string): CatalogParam[] {
  const m = new RegExp(`[\\s,;(]${name.replace(/\$/g, "\\$")}\\s*=\\s*p\\.Object\\(`).exec(src);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const objText = src.slice(open, balanced(src, open));
  const braceStart = objText.indexOf("{");
  if (braceStart < 0) return [];
  const body = objText.slice(braceStart + 1, balanced(objText, braceStart) - 1);
  const params: CatalogParam[] = [];
  for (const prop of splitTop(body)) {
    const pm = prop.match(/^\s*(?:\/\/[^\n]*\n\s*)*"?([A-Za-z_][\w]*)"?\s*:\s*([\s\S]*)$/);
    if (!pm) continue;
    const [, key, expr] = pm as unknown as [string, string, string];
    const e = expr.trim();
    const required = !e.startsWith("p.Optional(") && !/default:/.test(e);
    const type = (e.match(/p\.(String|Number|Boolean|Array|Union|Any|Object|Literal|Null)/) ?? [, "any"])[1]!.toLowerCase();
    const description = str(/description:\s*"((?:[^"\\]|\\.)*)"/, e);
    params.push({ name: key, type: type === "union" ? "string|number" : type, required, description });
  }
  return params;
}

export function buildCatalog(src: string): CatalogEntry[] {
  // 动作枚举:Key: "value"
  const names = new Map<string, string>();
  for (const m of src.matchAll(/\b([A-Za-z][A-Za-z0-9_]*):\s*"([a-z][a-z0-9_.]*)"/g)) {
    if (!names.has(m[1]!)) names.set(m[1]!, m[2]!);
  }
  const entries = new Map<string, CatalogEntry>();
  const re = /actionName\s*=\s*[A-Za-z_$][\w$]*\.([A-Za-z0-9_]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const action = names.get(m[1]!);
    if (!action) continue;
    const block = src.slice(m.index, m.index + 1500);
    const next = block.indexOf("\nclass ");
    const b = next > 0 ? block.slice(0, next) : block;
    const summary = str(/actionSummary\s*=\s*"((?:[^"\\]|\\.)*)"/, b);
    const description = str(/actionDescription\s*=\s*"((?:[^"\\]|\\.)*)"/, b);
    const tags = (b.match(/actionTags\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").split(",").map((t) => t.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const schema = b.match(/payloadSchema\s*=\s*([A-Za-z_$][\w$]*)\s*;/)?.[1];
    const params = schema ? parseSchema(src, schema) : [];
    if (!entries.has(action)) entries.set(action, { action, summary, description, tags, params });
  }
  return [...entries.values()].sort((a, b) => a.action.localeCompare(b.action));
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error("usage: gen-napcat-catalog.ts <napcat.mjs> [out.json]");
  const catalog = buildCatalog(readFileSync(input, "utf8"));
  const out = output ?? join(import.meta.dir, "..", "src", "napcat", "catalog.json");
  writeFileSync(out, JSON.stringify(catalog, null, 1));
  const withParams = catalog.filter((c) => c.params.length).length;
  console.log(`${catalog.length} actions (${withParams} with params) -> ${out}`);
}
