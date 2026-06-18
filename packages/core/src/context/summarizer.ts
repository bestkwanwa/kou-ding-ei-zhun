import { generateText, type ModelMessage, type ToolCallPart, type ToolResultPart } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const SUMMARY_START = "[Conversation Summary]";
const SUMMARY_END = "[/Conversation Summary]";

const COMPRESSION_PROMPT = `You are a conversation compression system. Compress the conversation history into a structured summary so the conversation can continue seamlessly.

You MUST respond with EXACTLY the following sections, using these exact headers. Replace the bracketed descriptions with actual content. Do NOT output anything outside these sections:

## User Intent
<what the user wanted to accomplish>

## Actions Taken
<tool calls executed by the agent and their results>

## Key Findings
<important points from files read, search results, command outputs>

## Current Status
<where the conversation stands, what remains undone>

## Details to Preserve
<file paths, variable names, config values, error messages — anything that cannot be lost>

Rules:
- Output in the same language used in the conversation
- File paths, UUIDs, version numbers must be preserved exactly — do not translate or rewrite
- Do not write vague overviews — only specific, actionable information
- Do NOT include full file contents or code snippets — describe what they do
- Total length under 800 words`;

export interface CompressionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

/**
 * 将 ModelMessage[] 转为纯文本 transcript。
 * 去掉 tool-call/tool-result 的结构化格式，避免 LLM 把它当成对话延续。
 */
function messagesToTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = typeof msg.content === "string"
          ? msg.content
          : (msg.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
        if (text.trim()) lines.push(`[User]\n${text}`);
        break;
      }
      case "assistant": {
        if (typeof msg.content === "string") {
          lines.push(`[Assistant]\n${msg.content}`);
        } else {
          for (const part of msg.content as Array<Record<string, unknown>>) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
              lines.push(`[Assistant]\n${part.text}`);
            }
            if (part.type === "tool-call") {
              const input = JSON.stringify(part.input);
              lines.push(`[Tool Call] ${part.toolName}(${input})`);
            }
          }
        }
        break;
      }
      case "tool": {
        const results = Array.isArray(msg.content)
          ? (msg.content as ToolResultPart[])
              .map((r) => r.output?.type === "text" ? r.output.value : "")
              .join("\n")
          : String(msg.content);
        lines.push(`[Tool Result]\n${results}`);
        break;
      }
    }
  }
  return lines.join("\n\n");
}

/**
 * 将全部消息压缩为结构化摘要。
 * - 触发时总结所有消息，不保留最近几轮
 * - 消息转为纯文本 transcript，避免 LLM 当成对话延续
 * - 已有摘要会被包含在 transcript 中，新摘要自动合并旧内容
 * - 摘要作为唯一的 user 消息注入
 */
export async function compressMessages(
  messages: ModelMessage[],
  model: LanguageModelV3,
): Promise<CompressionResult | null> {
  if (messages.length === 0) return null;

  const transcript = messagesToTranscript(messages);

  const result = await generateText({
    model,
    system: COMPRESSION_PROMPT,
    prompt: `Compress the following conversation history into a summary:\n\n${transcript}`,
    maxRetries: 0,
  });

  const summaryMsg: ModelMessage = {
    role: "user",
    content: `${SUMMARY_START}\n${result.text}\n${SUMMARY_END}`,
  };

  return {
    messages: [summaryMsg],
    summary: result.text,
    compressedCount: messages.length,
  };
}
