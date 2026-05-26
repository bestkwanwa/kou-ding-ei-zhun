import { tool as aiTool, type ToolSet } from "ai";
import type { Tool, ToolContext } from "../tools/types.js";

/**
 * Converts our Tool[] into AI SDK tool definitions WITHOUT execute functions.
 * Used when Effect manages the agent loop and tool execution.
 * AI SDK only sees tool schemas for the LLM call, never executes tools itself.
 */
export function toAiSdkToolDefinitions(tools: Tool[]): ToolSet {
  const result: ToolSet = {};

  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      inputSchema: t.parameters,
    } as any) as ToolSet[string];
  }

  return result;
}

/**
 * Converts our Tool[] into a full AI SDK ToolSet WITH execute functions.
 * Used when AI SDK manages tool execution internally.
 */
export function toAiSdkTools(tools: Tool[], ctx: ToolContext): ToolSet {
  const result: ToolSet = {};

  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      inputSchema: t.parameters,
      execute: async (args: Record<string, unknown>) => {
        return t.execute(args, ctx);
      },
    } as any) as ToolSet[string];
  }

  return result;
}
