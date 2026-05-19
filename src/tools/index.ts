import type { Tool } from "./types.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { listFilesTool } from "./list_files.js";
import { runCommandTool } from "./run_command.js";
import { searchFilesTool } from "./search_files.js";

export const allTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  runCommandTool,
  searchFilesTool,
];

export type { Tool, ToolContext } from "./types.js";
