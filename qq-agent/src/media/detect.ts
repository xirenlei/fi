export interface Detected {
  mime: string;
  ext: string;
  kind: "image" | "video";
  animated: boolean;
}

const startsWith = (b: Uint8Array, sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);

/** 通过文件头识别类型,不依赖扩展名 */
export function detectMedia(b: Uint8Array): Detected | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", ext: "png", kind: "image", animated: false };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", kind: "image", animated: false };
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", ext: "gif", kind: "image", animated: true };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    // WebP:VP8X 头里的动画标志位
    const animated = startsWith(b, [0x56, 0x50, 0x38, 0x58], 12) && ((b[20] ?? 0) & 0x02) !== 0;
    return { mime: "image/webp", ext: "webp", kind: "image", animated };
  }
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return { mime: "video/mp4", ext: "mp4", kind: "video", animated: true };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", ext: "webm", kind: "video", animated: true };
  return null;
}

/** 把摘要变成能放进文件名的字符串 */
export function safeName(s: string, max = 20): string {
  const t = s.replace(/[\\/:*?"<>|\s\u0000-\u001f.]+/g, "_").replace(/^_+|_+$/g, "");
  return Array.from(t).slice(0, max).join("") || "未命名";
}
