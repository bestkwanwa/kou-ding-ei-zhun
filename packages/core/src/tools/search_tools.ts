import { jsonSchema } from "ai";
import type { Tool, ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";

/**
 * 创建 search_tools 工具。通过闭包引用 registry 实现搜索。
 * 搜索后自动将匹配的 lazy 工具注册为已发现（可被后续调用）。
 */
export function createSearchToolsTool(registry: ToolRegistry): Tool {
  return {
    name: "search_tools",
    description:
      "Search for available tools by keyword. Returns full schema for matching tools. " +
      "Use this when you need a tool that isn't in your default set.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for (e.g. 'web', 'preview', 'fetch')",
        },
      },
      required: ["query"],
    }),
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
      const query = args.query as string;
      const tools = registry.searchTools(query);

      if (tools.length === 0) {
        return `No tools found matching "${query}".`;
      }

      // Mark matched tools as discovered
      for (const t of tools) {
        registry.discover(t.name);
      }

      const entries = tools.map((t) => {
        const params = t.parameters;
        return `## ${t.name}\n${t.description}\nParameters: ${JSON.stringify((params as any).schema ?? params)}`;
      });

      return `Found ${tools.length} tool(s). They are now available for use:\n\n${entries.join("\n\n")}`;
    },
    readOnly: true,
    parallelizable: true,
  };
}
