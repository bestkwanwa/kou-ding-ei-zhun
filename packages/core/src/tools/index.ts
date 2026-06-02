import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { listFilesTool } from "./list_files.js";
import { runCommandTool } from "./run_command.js";
import { searchFilesTool } from "./search_files.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { fetchUrlTool } from "./fetch_url.js";
import { previewTool } from "./preview.js";
import { webSearchTool } from "./web_search.js";
import { McpClient } from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/client.js";

const BUILTIN_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  runCommandTool,
  searchFilesTool,
  globTool,
  grepTool,
  fetchUrlTool,
  previewTool,
  webSearchTool,
];

/** 创建包含所有内置工具的 registry（同步，不连接 MCP servers） */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(BUILTIN_TOOLS);
  return registry;
}

/** 创建包含内置工具 + MCP server 工具的 registry */
export async function createRegistryWithMcp(
  mcpServers?: McpServerConfig[],
): Promise<ToolRegistry> {
  const registry = createDefaultRegistry();

  if (mcpServers?.length) {
    const client = new McpClient();
    const tools = await client.connectAll(mcpServers);
    registry.registerAll(tools);
  }

  return registry;
}

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, DEFAULT_MAX_RESULT_LENGTH } from "./types.js";
