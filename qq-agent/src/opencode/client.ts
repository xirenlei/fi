export interface OpenCodeMessage {
  info: { id: string; role: "user" | "assistant"; time: { created: number; completed?: number }; error?: { name: string; data?: { message?: string } } };
  parts: Array<{ type: string; text?: string }>;
}

export interface OcEvent {
  type: string;
  properties: Record<string, any>;
}

/** OpenCode `serve` 的 HTTP 接口封装(接口形状已对照 1.19 版本的真实服务验证) */
export class OpenCodeClient {
  constructor(
    private opts: { baseUrl: string; directory: string; password?: string },
  ) {}

  private url(path: string): string {
    const u = new URL(path, this.opts.baseUrl);
    u.searchParams.set("directory", this.opts.directory);
    return u.toString();
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.opts.password) h.authorization = `Basic ${Buffer.from(`opencode:${this.opts.password}`).toString("base64")}`;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/global/health", this.opts.baseUrl), { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(title: string): Promise<{ id: string }> {
    return this.req("POST", "/session", { title });
  }

  async promptAsync(sessionId: string, text: string, model?: { providerID: string; modelID: string }): Promise<void> {
    await this.req("POST", `/session/${sessionId}/prompt_async`, { parts: [{ type: "text", text }], ...(model ? { model } : {}) });
  }

  async messages(sessionId: string): Promise<OpenCodeMessage[]> {
    return this.req("GET", `/session/${sessionId}/message`);
  }

  async abort(sessionId: string): Promise<void> {
    await this.req("POST", `/session/${sessionId}/abort`);
  }

  async setAuth(providerId: string, key: string): Promise<void> {
    await this.req("PUT", `/auth/${providerId}`, { type: "api", key });
  }

  async patchConfig(patch: Record<string, unknown>): Promise<void> {
    await this.req("PATCH", "/config", patch);
  }

  /** 订阅事件流,连接断开时返回;调用方负责重连 */
  async subscribe(onEvent: (e: OcEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url("/event"), { headers: this.headers(), signal });
    if (!res.ok || !res.body) throw new Error(`opencode event stream HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* 忽略无法解析的事件 */
        }
      }
    }
  }
}

/** 取一次任务(最后一条用户消息之后)的助手文字输出和错误 */
export function collectResult(msgs: OpenCodeMessage[]): { text: string; error?: string; completed: boolean } {
  let start = 0;
  msgs.forEach((m, i) => {
    if (m.info.role === "user") start = i + 1;
  });
  const replies = msgs.slice(start).filter((m) => m.info.role === "assistant");
  const text = replies
    .flatMap((m) => m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!))
    .join("\n")
    .trim();
  const err = replies.find((m) => m.info.error)?.info.error;
  const completed = replies.length > 0 && replies.every((m) => m.info.time.completed != null || m.info.error);
  return { text, error: err ? (err.data?.message ?? err.name) : undefined, completed };
}
