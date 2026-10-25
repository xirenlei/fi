export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  /** 思考内容(DeepSeek 的 reasoning_content) */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  thinking?: { enabled: boolean; effort?: string };
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** OpenAI 兼容的 Chat Completions 客户端(针对 DeepSeek 的思考内容做了处理) */
export class LlmClient {
  constructor(private getSettings: () => LlmSettings) {}

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const s = this.getSettings();
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.thinking) {
      if (opts.thinking.enabled) {
        body.thinking = { type: "enabled" };
        if (opts.thinking.effort) body.reasoning_effort = opts.thinking.effort;
      } else {
        body.thinking = { type: "disabled" };
        if (opts.temperature !== undefined) body.temperature = opts.temperature;
      }
    }
    Object.assign(body, s.extraBody ?? {});

    const url = `${s.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const retries = s.retries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(s.timeoutMs ?? 120_000),
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
          if (res.status === 429 || res.status >= 500) throw err;
          throw Object.assign(err, { fatal: true });
        }
        const json = JSON.parse(text);
        const choice = json.choices?.[0];
        if (!choice?.message) throw new LlmError(`LLM response has no message: ${text.slice(0, 300)}`);
        return { message: choice.message as ChatMessage, finishReason: choice.finish_reason ?? "", usage: json.usage };
      } catch (e) {
        lastErr = e;
        if ((e as { fatal?: boolean }).fatal || attempt === retries) break;
        await Bun.sleep((s.retryDelayMs ?? 1000) * 2 ** attempt);
      }
    }
    throw lastErr;
  }
}

export function stripAllReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!("reasoning_content" in m)) return m;
    const { reasoning_content: _drop, ...rest } = m;
    return rest;
  });
}

export function textOf(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  return "";
}
