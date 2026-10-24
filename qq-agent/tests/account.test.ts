import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/agent/tools";
import { MediaStore } from "../src/media/store";
import { Db } from "../src/memory/db";
import { accountTools } from "../src/tools/account";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "qqa-acct-"));
  const db = new Db(":memory:");
  const store = new MediaStore(db, dir);
  const calls: Array<[string, any]> = [];
  const reg = new ToolRegistry(
    accountTools({
      store,
      async call(action, params) {
        calls.push([action, params]);
        return action === "send_qzone_msg" ? { tid: "abc123" } : null;
      },
    }),
  );
  const img = store.add({ kind: "image", data: new Uint8Array([1, 2, 3]), ext: "png", mime: "image/png", summary: "夕阳" });
  const vid = store.add({ kind: "video", data: new Uint8Array([4, 5, 6]), ext: "mp4", mime: "video/mp4", summary: "视频" });
  return { reg, calls, img, vid, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const admin = { space: "g:9", triggerSenderIds: [1] };
const guest = admin;

test("改签名、昵称、在线状态", async () => {
  const t = setup();
  await t.reg.run("set_signature", '{"text":"今天也要开心"}', admin);
  await t.reg.run("set_nickname", '{"nickname":"小助"}', admin);
  await t.reg.run("set_online_status", '{"status":"busy"}', admin);
  expect(t.calls).toEqual([
    ["set_self_longnick", { longNick: "今天也要开心" }],
    ["set_qq_profile", { nickname: "小助" }],
    ["set_online_status", { status: 50, ext_status: 0, battery_status: 0 }],
  ]);
  t.cleanup();
});

test("换头像:用图库编号,视频和不存在的编号被拒绝", async () => {
  const t = setup();
  expect(await t.reg.run("set_avatar", JSON.stringify({ media_id: t.img.id }), admin)).toBe("头像已修改");
  expect(t.calls[0]![0]).toBe("set_qq_avatar");
  expect(t.calls[0]![1].file).toBe(`file://${t.store.absPath(t.img)}`);
  expect(await t.reg.run("set_avatar", JSON.stringify({ media_id: t.vid.id }), admin)).toContain("是视频");
  expect(await t.reg.run("set_avatar", '{"media_id":999}', admin)).toContain("没有编号 999");
  expect(await t.reg.run("set_avatar", "{}", admin)).toContain("需要 media_id");
  t.cleanup();
});

test("发动态:正文、图片、可见范围;删除动态", async () => {
  const t = setup();
  const out = await t.reg.run("post_qzone", JSON.stringify({ content: "晚霞很美", media_ids: [t.img.id], visibility: "friends" }), admin);
  expect(out).toContain("abc123");
  expect(t.calls[0]).toEqual(["send_qzone_msg", { content: "晚霞很美", images: [`file://${t.store.absPath(t.img)}`], ugc_right: 4 }]);
  expect(await t.reg.run("post_qzone", '{"content":"x","visibility":"bogus"}', admin)).toContain("不合法");
  await t.reg.run("delete_qzone", '{"tid":"abc123"}', admin);
  expect(t.calls.at(-1)).toEqual(["delete_qzone_msg", { tid: "abc123" }]);
  t.cleanup();
});

test("点赞、戳一戳、表情回应", async () => {
  const t = setup();
  await t.reg.run("send_like", '{"user_id":5,"times":99}', guest);
  await t.reg.run("poke", '{"user_id":5}', guest);
  await t.reg.run("poke", '{"user_id":5}', { ...guest, space: "p:5" });
  await t.reg.run("poke", '{"user_id":5,"group_id":42}', { ...guest, space: "self" });
  await t.reg.run("react_to_message", '{"message_id":77,"emoji_id":76}', guest);
  expect(t.calls).toEqual([
    ["send_like", { user_id: "5", times: 10 }],
    ["send_poke", { user_id: "5", group_id: "9" }],
    ["send_poke", { user_id: "5" }],
    ["send_poke", { user_id: "5", group_id: "42" }],
    ["set_msg_emoji_like", { message_id: 77, emoji_id: 76, set: true }],
  ]);
  t.cleanup();
});
