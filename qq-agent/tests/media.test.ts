import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/agent";
import { ToolRegistry, memoryTools } from "../src/agent/tools";
import { defaultConfig, mergeConfig } from "../src/config";
import { LlmClient, type ChatMessage } from "../src/llm/client";
import { Db } from "../src/memory/db";
import { detectMedia, safeName } from "../src/media/detect";
import { parseDescription } from "../src/media/describe";
import { hasFfmpeg } from "../src/media/ffmpeg";
import { MediaPipeline } from "../src/media/handler";
import { MediaStore } from "../src/media/store";
import { mediaTools } from "../src/media/tools";
import { seg } from "../src/napcat/parse";
import type { OneBotEvent, Segment, SpaceId } from "../src/napcat/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const FF = await hasFfmpeg();

async function gen(args: string[], out: string): Promise<Uint8Array> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args, out], { stdout: "ignore", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error("ffmpeg gen failed");
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

let png: Uint8Array, gif: Uint8Array, mp4: Uint8Array, png2: Uint8Array;
const tmp = mkdtempSync(join(tmpdir(), "qqa-test-"));
cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(async () => {
  if (!FF) return;
  png = await gen(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"], join(tmp, "a.png"));
  png2 = await gen(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1"], join(tmp, "b.png"));
  gif = await gen(["-f", "lavfi", "-i", "testsrc=s=64x64:d=1:r=5"], join(tmp, "c.gif"));
  mp4 = await gen(["-f", "lavfi", "-i", "testsrc=s=128x128:d=2:r=10", "-pix_fmt", "yuv420p"], join(tmp, "d.mp4"));
});

describe("detect", () => {
  test("文件头识别", () => {
    expect(detectMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))!.ext).toBe("png");
    expect(detectMedia(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))!.animated).toBe(true);
    expect(detectMedia(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
  test("文件名净化", () => {
    expect(safeName('猫猫/摸头: "杀"?')).toBe("猫猫_摸头_杀");
    expect(safeName("   ")).toBe("未命名");
  });
  test("描述解析容错", () => {
    expect(parseDescription('前言 {"summary":"开心的猫","detail":"一只猫","tags":["猫","开心"]} 后记').tags).toEqual(["猫", "开心"]);
    expect(parseDescription("不是 json").summary).toBe("未识别");
  });
});

function setup(descriptions: string[]) {
  const db = new Db(":memory:");
  const store = new MediaStore(db, join(tmp, `lib-${Math.random().toString(36).slice(2)}`));
  const llmCalls: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      llmCalls.push(body);
      const isDescribe = JSON.stringify(body.messages).includes("图片索引员");
      const content = isDescribe ? (descriptions.shift() ?? '{"summary":"默认"}') : "<msg>收到</msg>";
      return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    },
  });
  cleanups.push(() => server.stop(true));
  const llm = new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 }));
  const cfg = mergeConfig(defaultConfig, { behavior: { typingMsPerChar: 0 } });
  const sources = new Map<string, Uint8Array>();
  const pipeline = new MediaPipeline({
    store,
    llm,
    cfg: () => cfg,
    log: () => {},
    fetchBytes: async (ref) => sources.get(ref.url!)!,
  });
  return { db, store, llm, cfg, pipeline, llmCalls, sources };
}

describe.skipIf(!FF)("MediaPipeline", () => {
  test("静态图入库并生成带描述的占位文本,相同图片不重复描述", async () => {
    const t = setup(['{"summary":"一块红色","detail":"纯红色方块","tags":["红"]}']);
    t.sources.set("u1", png);
    const parsed = { text: "看 [图片]", media: [{ kind: "image" as const, url: "u1", isSticker: false }] };
    const r1 = await t.pipeline.ingest(parsed, "p:7");
    expect(r1.text).toBe("看 [图片#1:一块红色]");
    expect(r1.images).toHaveLength(1);
    expect(r1.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(t.llmCalls).toHaveLength(1);
    // 描述请求里带了图片
    expect(JSON.stringify(t.llmCalls[0].messages)).toContain("image_url");

    const r2 = await t.pipeline.ingest(parsed, "p:7");
    expect(r2.text).toBe("看 [图片#1:一块红色]");
    expect(r2.images).toHaveLength(0); // 已有的不再注入图片
    expect(t.llmCalls).toHaveLength(1); // 不再请求描述
    const item = t.store.get(1)!;
    expect(item.file).toMatch(/^image\/一块红色_[0-9a-f]{8}\.png$/);
    expect(existsSync(t.store.absPath(item))).toBe(true);
  });

  test("表情包、动图、视频分别抽帧并按类别归档", async () => {
    const t = setup([
      '{"summary":"无语的猫","tags":["无语","猫"]}',
      '{"summary":"测试动图"}',
      '{"summary":"测试视频"}',
    ]);
    t.sources.set("s", png2);
    t.sources.set("g", gif);
    t.sources.set("v", mp4);
    const r = await t.pipeline.ingest(
      {
        text: "[表情包][图片][视频]",
        media: [
          { kind: "image", url: "s", isSticker: true },
          { kind: "image", url: "g", isSticker: false },
          { kind: "video", url: "v" },
        ],
      },
      "g:1",
    );
    expect(r.text).toBe("[表情包#1:无语的猫][动图#2:测试动图][视频#3:测试视频]");
    expect(t.store.get(1)!.kind).toBe("sticker");
    expect(t.store.get(2)!.animated).toBe(true);
    expect(t.store.get(3)!.kind).toBe("video");
    // 1 张表情包 + 动图 ≤3 帧 + 视频 4 帧
    expect(r.images.length).toBeGreaterThanOrEqual(1 + 2 + 3);
    expect(t.store.search("无语")[0]!.id).toBe(1);
    expect(t.store.search("猫", { kind: "video" })).toHaveLength(0);
  });

  test("下载失败时占位而不是整条消息出错", async () => {
    const t = setup([]);
    const r = await t.pipeline.ingest({ text: "[图片]", media: [{ kind: "image", url: "missing" }] }, "p:1");
    expect(r.text).toBe("[图片:读取失败]");
  });

  test("发送:表情包带 sub_type,类别不符不发送", async () => {
    const t = setup(['{"summary":"开心"}', '{"summary":"视频"}']);
    t.sources.set("s", png);
    t.sources.set("v", mp4);
    await t.pipeline.ingest({ text: "[表情包][视频]", media: [{ kind: "image", url: "s", isSticker: true }, { kind: "video", url: "v" }] }, "p:1");
    const sticker = await t.pipeline.resolveOut({ kind: "sticker", ref: "1" });
    expect(sticker!.segment.type).toBe("image");
    expect((sticker!.segment.data as any).sub_type).toBe(1);
    expect((sticker!.segment.data as any).file).toStartWith("file://");
    expect(await t.pipeline.resolveOut({ kind: "video", ref: "1" })).toBeNull();
    expect((await t.pipeline.resolveOut({ kind: "video", ref: "2" }))!.segment.type).toBe("video");
    expect(await t.pipeline.resolveOut({ kind: "sticker", ref: "999" })).toBeNull();
    // 按关键词也能解析
    expect((await t.pipeline.resolveOut({ kind: "sticker", ref: "开心" }))!.label).toContain("开心");
  });

  test("工具:搜索、改类别、删除", async () => {
    const t = setup(['{"summary":"红色方块","tags":["红"]}']);
    t.sources.set("u", png);
    await t.pipeline.ingest({ text: "[图片]", media: [{ kind: "image", url: "u" }] }, "p:1");
    const reg = new ToolRegistry(mediaTools(t.store));
    const ctx = { space: "p:1", triggerSenderIds: [] };
    expect(await reg.run("media_search", '{"query":"红"}', ctx)).toContain("#1");
    expect(await reg.run("media_set_kind", '{"id":1,"kind":"sticker"}', ctx)).toContain("sticker");
    expect(t.store.get(1)!.file.startsWith("sticker/")).toBe(true);
    expect(existsSync(t.store.absPath(t.store.get(1)!))).toBe(true);
    expect(await reg.run("media_list", "{}", ctx)).toContain("#1");
    expect(await reg.run("media_delete", '{"id":1}', ctx)).toBe("已删除");
    expect(await reg.run("media_list", "{}", ctx)).toBe("图库是空的");
  });

  test("集成:群里的图片只在第一轮注入,之后只剩摘要;模型能发表情包", async () => {
    const t = setup(['{"summary":"红色方块"}']);
    t.sources.set("u", png);
    const sent: Array<{ space: string; message: Segment[] }> = [];
    const napcat = {
      selfId: 100,
      async send(space: SpaceId, message: Segment[]) {
        sent.push({ space, message });
        return 5000 + sent.length;
      },
      async call<T>(): Promise<T> {
        return { group_name: "g" } as T;
      },
    };
    const mainCalls: any[] = [];
    const llm = new LlmClient(() => ({ baseUrl: "http://x", apiKey: "k", retries: 0 }));
    // 用脚本化的模型替换:第一轮发表情包,第二轮沉默
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        mainCalls.push(body);
        const content = mainCalls.length === 1 ? '<msg>好图</msg><msg><sticker id="1"/></msg>' : "<silent/>";
        return Response.json({ choices: [{ message: { role: "assistant", content } as ChatMessage, finish_reason: "stop" }] });
      },
    });
    cleanups.push(() => server.stop(true));
    const mainLlm = new LlmClient(() => ({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", retries: 0 }));
    void llm;
    const pipeline = new MediaPipeline({ store: t.store, llm: t.llm, cfg: () => t.cfg, log: () => {}, fetchBytes: async () => png });
    const agent = new Agent({
      cfg: () => t.cfg,
      db: t.db,
      napcat,
      llm: mainLlm,
      tools: new ToolRegistry([...memoryTools(t.db), ...mediaTools(t.store)]),
      media: pipeline,
      sleep: async () => {},
      log: () => {},
    });
    const ev = (id: number, segs: any[]): OneBotEvent => ({
      post_type: "message", message_type: "private", message_id: id, user_id: 7, self_id: 100, time: 1700000000 + id, message: segs, sender: { nickname: "u7" },
    });
    await agent.handleEvent(ev(1, [seg.text("看这个"), { type: "image", data: { url: "u", sub_type: 0 } }]));
    await agent.idle();
    const first = JSON.stringify(mainCalls[0].messages.at(-1));
    expect(first).toContain("image_url"); // 第一轮带图
    expect(first).toContain("[图片#1:红色方块]");
    expect(mainCalls[0].tools.map((x: any) => x.function.name)).toContain("media_search");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message[0]!.type).toBe("image");
    expect((sent[1]!.message[0]!.data as any).file).toStartWith("file://");

    await agent.handleEvent(ev(2, [seg.text("再说一句")]));
    await agent.idle();
    // 第二轮历史里的图片只剩摘要,没有 image_url
    expect(JSON.stringify(mainCalls[1].messages)).not.toContain("image_url");
    expect(JSON.stringify(mainCalls[1].messages)).toContain("[图片#1:红色方块]");
    // 图库里存的是原图
    expect(t.store.get(1)!.size).toBe(png.length);
  });
});
