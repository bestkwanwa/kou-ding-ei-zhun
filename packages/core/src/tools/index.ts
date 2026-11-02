import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { listFilesTool } from "./list_files.js";
import { runCommandTool } from "./run_command.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { fetchUrlTool } from "./fetch_url.js";
import { previewTool } from "./preview.js";
import { webSearchTool } from "./web_search.js";
import { createMemoryTool } from "./memory.js";
import { createSearchToolsTool } from "./search_tools.js";
import { MemoryStore } from "../memory/index.js";

/** 创建包含所有内置工具的 registry */
export function createDefaultRegistry(cwd: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    runCommandTool,
    globTool,
    grepTool,
    fetchUrlTool,
    previewTool,
    webSearchTool,
  ]);
  // 系统级工具：依赖外显构造 + init，经参数注入工厂
  const memoryStore = new MemoryStore(cwd);
  memoryStore.init();
  registry.register(createSearchToolsTool(registry));
  registry.register(createMemoryTool(memoryStore));
  return registry;
}

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, DEFAULT_MAX_RESULT_LENGTH } from "./types.js";
