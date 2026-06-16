import type { ModelMessage, ToolResultPart, ToolCallPart } from "ai";
import type { ToolRegistry } from "../tools/registry.js";

/** 保留最近几轮的完整工具结果 */
export const DEFAULT_KEEP_TOOL_RESULT_ROUNDS = 3;

/**
 * 创建清理副本：将旧轮次的 cleanable 工具结果替换为占位符。
 * 不修改原数组，返回新数组。错误信息（以 "Error" 开头）不参与清理。
 */
export function cleanupToolResults(
  messages: ModelMessage[],
  registry: ToolRegistry,
  keepRounds: number = DEFAULT_KEEP_TOOL_RESULT_ROUNDS,
): { messages: ModelMessage[]; cleanedCount: number } {
  // 1. 找到所有 tool 消息的索引
  const toolMsgIndices: number[] = [];
  messages.forEach((msg, i) => {
    if (msg.role === "tool") toolMsgIndices.push(i);
  });

  // 2. 轮数不够，无需清理
  if (toolMsgIndices.length <= keepRounds) {
    return { messages, cleanedCount: 0 };
  }

  // 3. cutoff：此索引及之后的 tool 消息保留原样
  const cutoffIdx = toolMsgIndices[toolMsgIndices.length - keepRounds];

  // 4. 构建 toolCallId → input 映射（从 assistant 消息的 tool-call 中提取）
  const callInputs = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as ToolCallPart[]) {
        if (part.type === "tool-call") {
          callInputs.set(part.toolCallId, part.input as Record<string, unknown>);
        }
      }
    }
  }

  // 5. 清理旧 tool 消息中的 cleanable 结果
  let cleanedCount = 0;
  const result = messages.map((msg, i) => {
    if (i >= cutoffIdx || msg.role !== "tool") return msg;

    const content = (msg.content as ToolResultPart[]).map((tr) => {
      const tool = registry.get(tr.toolName);
      if (!tool?.cleanable) return tr;
      if (tr.output.type !== "text") return tr;

      const value = tr.output.value;
      // 错误信息不清理
      if (value.startsWith("Error")) return tr;

      // 提取参数摘要
      const input = callInputs.get(tr.toolCallId) ?? {};
      const arg = [input.path, input.command, input.pattern, input.query]
        .find((v) => typeof v === "string") ?? "";
      const argStr = arg ? `("${arg}")` : "";

      cleanedCount++;
      return {
        ...tr,
        output: {
          type: "text" as const,
          value: `[Context cleared: ${tr.toolName}${argStr} returned ${value.length} chars]`,
        },
      };
    });

    return { ...msg, content };
  });

  return { messages: result, cleanedCount };
}
