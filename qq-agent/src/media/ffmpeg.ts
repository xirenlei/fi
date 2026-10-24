import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Exec {
  (cmd: string[]): Promise<{ code: number; stdout: string }>;
}

export const defaultExec: Exec = async (cmd) => {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
};

export async function hasFfmpeg(exec: Exec = defaultExec): Promise<boolean> {
  return (await exec(["ffmpeg", "-version"])).code === 0;
}

async function duration(exec: Exec, file: string): Promise<number> {
  const r = await exec(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const n = Number.parseFloat(r.stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从视频或动图里抽 count 帧,缩放到最长边不超过 maxSide,返回 jpeg 数据。
 * 没有 ffmpeg 或抽取失败时返回空数组。
 */
export async function extractFrames(
  data: Uint8Array,
  ext: string,
  count: number,
  maxSide = 640,
  exec: Exec = defaultExec,
): Promise<Uint8Array[]> {
  const dir = mkdtempSync(join(tmpdir(), "qqa-frames-"));
  try {
    const input = join(dir, `in.${ext}`);
    writeFileSync(input, data);
    const dur = await duration(exec, input);
    const times = dur > 0 && count > 1 ? Array.from({ length: count }, (_, i) => (dur * (i + 0.5)) / count) : [0];
    const frames: Uint8Array[] = [];
    for (const [i, t] of times.entries()) {
      const out = join(dir, `f${i}.jpg`);
      const r = await exec([
        "ffmpeg", "-v", "error", "-y", "-ss", t.toFixed(2), "-i", input, "-frames:v", "1",
        "-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
        out,
      ]);
      if (r.code === 0) {
        try {
          frames.push(readFileSync(out));
        } catch {
          /* 这一帧失败就跳过 */
        }
      }
    }
    return frames;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把静态图缩小成 jpeg,用于喂给模型;没有 ffmpeg 时返回 null */
export async function shrinkImage(data: Uint8Array, ext: string, maxSide = 1024, exec: Exec = defaultExec): Promise<Uint8Array | null> {
  const frames = await extractFrames(data, ext, 1, maxSide, exec);
  return frames[0] ?? null;
}
