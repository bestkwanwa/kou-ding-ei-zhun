import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { listFilesTool } from "./list_files.js";
import { runCommandTool } from "./run_command.js";
import { searchFilesTool } from "./search_files.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";

/** 创建包含所有内置工具的 registry */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    runCommandTool,
    searchFilesTool,
    globTool,
    grepTool,
  ]);
  return registry;
}

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, DEFAULT_MAX_RESULT_LENGTH } from "./types.js";
