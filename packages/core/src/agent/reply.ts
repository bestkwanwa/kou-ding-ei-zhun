import type { ModelMessage } from "ai";

/**
 * 提取 [fromIndex, messages.length) 内最后一条含文本的 assistant 消息（本轮最终回复）。
 * 支持 string 与数组 content（拼接 text parts）；区间内无文本（预算耗尽/循环检测早停的
 * 轮次可能没有最终 assistant 文本）返回 "(no reply)"。
 * 绝不越过 fromIndex 取旧一轮的回复 —— 否则会把上一轮的内容重发给渠道。
 */
export function extractReply(fromIndex: number, messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = assistantText(msg.content);
    if (text) return text;
  }
  return "(no reply)";
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
      )
      .map((part) => part.text)
      .join("")
      .trim();
  }
  return "";
}
