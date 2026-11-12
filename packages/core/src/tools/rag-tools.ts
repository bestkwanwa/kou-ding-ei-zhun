import { jsonSchema } from "ai";
import type { RagService } from "../rag/service.js";
import { TOP_K_DEFAULT } from "../rag/types.js";
import type { Tool } from "./types.js";

/**
 * 创建 RAG 双工具（与 memory 同为系统级工具：依赖外显构造，经参数注入工厂）。
 * ingest_docs：加载 → 分块 → 向量化 → 入库（增量，hash 未变跳过）。
 * search_knowledge：混合检索（70% 向量 + 30% 关键词），结果作为 tool result 进入对话。
 */
export function createRagTools(service: RagService): { ingestDocsTool: Tool; searchKnowledgeTool: Tool } {
  const ingestDocsTool: Tool = {
    name: "ingest_docs",
    description:
      "Index markdown documents from .kda/knowledge/ into the searchable knowledge base " +
      "(chunking + embeddings + SQLite storage). Call it after adding or editing documents there, " +
      "or before the first search_knowledge call in a project. Only files whose content changed are re-indexed.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Optional: relative path of one file under .kda/knowledge/ (e.g. "api-guide.md"). Omit to ingest all files.',
        },
      },
      required: [],
    }),
    async execute(args) {
      try {
        const filter = ((args.path as string) ?? "").trim() || undefined;
        const s = await service.ingest(filter);
        if (s.scanned === 0 && s.updated === 0 && s.staleRemoved === 0) {
          return "Error: no .md files found under .kda/knowledge/ — add documents there first";
        }
        const lines = s.files.map((f) => `- ${f.path} (${f.chunks} chunks)`);
        return (
          `Ingested ${s.updated} file(s), skipped ${s.skipped} unchanged. ${s.chunks} chunks indexed.` +
          (lines.length > 0 ? "\n" + lines.join("\n") : "") +
          (s.staleRemoved > 0 ? `\nRemoved ${s.staleRemoved} deleted file(s).` : "")
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    maxResultLength: 1_000,
  };

  const searchKnowledgeTool: Tool = {
    name: "search_knowledge",
    description:
      "Hybrid search (70% vector similarity + 30% keyword) over the indexed knowledge base (.kda/knowledge/). " +
      "Call it BEFORE answering questions that might be covered by the project's knowledge documents, " +
      "then verify the retrieved content against the codebase — results are clues, not facts.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (use the same language as the documents)",
        },
        top_k: {
          type: "number",
          description: `Number of chunks to return, 1-10 (default ${TOP_K_DEFAULT})`,
        },
      },
      required: ["query"],
    }),
    async execute(args) {
      try {
        const query = ((args.query as string) ?? "").trim();
        if (!query) return "Error: query is required";
        const topK = Math.max(1, Math.min(10, (args.top_k as number) ?? TOP_K_DEFAULT));
        if (service.documentCount() === 0) {
          return "Error: knowledge base is empty — call ingest_docs first";
        }
        const results = await service.search(query, topK);
        return service.formatResults(results);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    maxResultLength: 8_000,
  };

  return { ingestDocsTool, searchKnowledgeTool };
}
