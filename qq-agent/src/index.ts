import { join } from "node:path";
import { dataDir, loadConfig } from "./config";
import { Db } from "./memory/db";
import { NapcatClient, isMessageEvent } from "./napcat/client";
import { displayName, parseMessage } from "./napcat/parse";
import { spaceOf } from "./napcat/types";

const cfg = loadConfig();
const db = new Db(join(dataDir(), "agent.db"));
const napcat = new NapcatClient({ wsUrl: cfg.napcat.wsUrl, token: cfg.napcat.token });

napcat.onEvent((ev) => {
  if (!isMessageEvent(ev)) return;
  const parsed = parseMessage(ev);
  const space = spaceOf(ev);
  const isSelf = ev.post_type === "message_sent";
  db.addMessage({
    space,
    msgId: ev.message_id,
    ts: ev.time,
    senderId: ev.user_id,
    senderName: displayName(ev),
    role: isSelf ? "self" : "user",
    text: parsed.text,
  });
  console.log(`[${space}] ${displayName(ev)}: ${parsed.text}`);
});

napcat.connect();
await napcat.waitOpen(30_000);
const me = await napcat.getLoginInfo();
console.log(`logged in as ${me.nickname} (${me.user_id})`);
