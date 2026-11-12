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
import { createRagTools } from "./rag-tools.js";
import { createSearchToolsTool } from "./search_tools.js";
import { MemoryStore } from "../memory/index.js";
import { RagStore, createRagService, createEmbedder, DEFAULT_RAG_DB_FILENAME } from "../rag/index.js";
import { resolve } from "node:path";

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
  // RAG 工具
  const ragStore = new RagStore(resolve(cwd, ".kda", "rag", process.env.RAG_DB_FILENAME ?? DEFAULT_RAG_DB_FILENAME));
  ragStore.init();
  const ragService = createRagService({ cwd, store: ragStore, embedder: createEmbedder() });
  const { ingestDocsTool, searchKnowledgeTool } = createRagTools(ragService);
  registry.register(createSearchToolsTool(registry));
  registry.register(createMemoryTool(memoryStore));
  registry.register(ingestDocsTool);
  registry.register(searchKnowledgeTool);
  return registry;
}

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, DEFAULT_MAX_RESULT_LENGTH } from "./types.js";
