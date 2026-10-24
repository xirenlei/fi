import type { ActionResponse, MessageEvent, OneBotEvent, Segment, SpaceId } from "./types";
import { parseSpace } from "./types";

type EventHandler = (ev: OneBotEvent) => void | Promise<void>;

interface Pending {
  resolve: (r: ActionResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NapcatOptions {
  wsUrl: string;
  token?: string;
  reconnectMs?: number;
  log?: (msg: string) => void;
}

/** OneBot 11 正向 WebSocket 客户端,断线自动重连 */
export class NapcatClient {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private handlers: EventHandler[] = [];
  private seq = 0;
  private closed = false;
  private openWaiters: Array<() => void> = [];
  selfId?: number;

  constructor(private opts: NapcatOptions) {}

  private log(msg: string) {
    (this.opts.log ?? console.log)(`[napcat] ${msg}`);
  }

  onEvent(h: EventHandler) {
    this.handlers.push(h);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closed = false;
    const url = new URL(this.opts.wsUrl);
    if (this.opts.token) url.searchParams.set("access_token", this.opts.token);
    const ws = new WebSocket(url.toString());
    this.ws = ws;

    ws.onopen = () => {
      this.log("connected");
      for (const w of this.openWaiters.splice(0)) w();
    };
    ws.onmessage = (m) => this.handleRaw(String(m.data));
    ws.onclose = () => {
      this.failAllPending(new Error("napcat connection closed"));
      if (this.closed) return;
      this.log("disconnected, retrying");
      setTimeout(() => this.connect(), this.opts.reconnectMs ?? 3000);
    };
    ws.onerror = () => {
      /* onclose 会随后触发并负责重连 */
    };
  }

  waitOpen(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("napcat connect timeout")), timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private handleRaw(raw: string) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof obj.echo === "string" && this.pending.has(obj.echo)) {
      const p = this.pending.get(obj.echo)!;
      this.pending.delete(obj.echo);
      clearTimeout(p.timer);
      p.resolve(obj as unknown as ActionResponse);
      return;
    }
    if (typeof obj.post_type !== "string") return;
    const ev = obj as OneBotEvent;
    if (typeof ev.self_id === "number") this.selfId = ev.self_id;
    for (const h of this.handlers) {
      Promise.resolve(h(ev)).catch((e) => this.log(`event handler error: ${e}`));
    }
  }

  private failAllPending(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** 调用 OneBot 动作,retcode 非 0 时抛错 */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.connected) throw new Error("napcat not connected");
    const echo = `${Date.now()}-${++this.seq}`;
    const res = await new Promise<ActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`action ${action} timeout`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ action, params, echo }));
    });
    if (res.retcode !== 0 && res.status !== "async") {
      throw new Error(`action ${action} failed: retcode=${res.retcode} ${res.message ?? ""}`);
    }
    return res.data as T;
  }

  /** 向某个空间发送一条消息,返回 message_id */
  async send(space: SpaceId, message: Segment[]): Promise<number> {
    const { type, id } = parseSpace(space);
    const params = type === "group" ? { group_id: id, message } : { user_id: id, message };
    const data = await this.call<{ message_id: number }>(type === "group" ? "send_group_msg" : "send_private_msg", params);
    return data.message_id;
  }

  async getLoginInfo(): Promise<{ user_id: number; nickname: string }> {
    const info = await this.call<{ user_id: number; nickname: string }>("get_login_info");
    this.selfId = info.user_id;
    return info;
  }
}

export function isMessageEvent(ev: OneBotEvent): ev is OneBotEvent & MessageEvent {
  return ev.post_type === "message" || ev.post_type === "message_sent";
}
