import type { LlmClient } from "../llm/client";
import { textOf } from "../llm/client";
import type { StoredMessage } from "../memory/db";
import { formatMessage } from "./prompt";

const JUDGE_SYSTEM = `你在帮一个 QQ 群里的成员判断:看到最新的消息后,TA 要不要接话。
接话的情形:有人在问大家或没人接的问题、话题和 TA 有关或 TA 能提供有价值的信息、气氛合适且自然。
不接话的情形:别人之间的私密对话、与 TA 无关的闲聊、TA 刚说过话、没什么可补充的。
宁可少说,不要频繁插嘴。只输出 JSON:{"reply": true} 或 {"reply": false}。`;

export interface JudgeInput {
  persona: string;
  context: StoredMessage[];
  /** 距离上次发言的秒数,没发过言则为 null */
  sinceLastSpokeSec: number | null;
}

export function parseJudge(text: string): boolean {
  const m = text.match(/"reply"\s*:\s*(true|false)/i);
  return m ? m[1]!.toLowerCase() === "true" : false;
}

export async function judgeReply(llm: LlmClient, model: string, input: JudgeInput): Promise<boolean> {
  const last = input.sinceLastSpokeSec == null ? "TA 还没在这个群说过话。" : `TA 上次发言是 ${input.sinceLastSpokeSec} 秒前。`;
  const user = [`TA 的人设:${input.persona}`, last, "最近的群聊记录:", ...input.context.map(formatMessage), "TA 要接话吗?"].join("\n");
  const res = await llm.chat({
    model,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: user },
    ],
    thinking: { enabled: false },
    maxTokens: 30,
  });
  return parseJudge(textOf(res.message));
}
