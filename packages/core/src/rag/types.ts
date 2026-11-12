export interface RagDoc {
  /** 相对 .kda/knowledge/ 的路径 */
  path: string;
  content: string;
  hash: string;
}

export interface RagChunk {
  /** 全文档内递增序号 */
  ordinal: number;
  /** 分块所在的最近标题（无则空串） */
  heading: string;
  text: string;
}

export interface RetrievedChunk {
  chunkId: number;
  docPath: string;
  heading: string;
  text: string;
  /** 融合分（0.7 向量 + 0.3 关键词，各自 min-max 归一） */
  score: number;
  vecScore?: number;
  kwScore?: number;
}

export interface IngestSummary {
  scanned: number;
  updated: number;
  skipped: number;
  chunks: number;
  files: { path: string; chunks: number }[];
  staleRemoved: number;
}

export const CHUNK_MAX_TOKENS = 256;
export const EST_CHARS_PER_TOKEN = 4;
export const VECTOR_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;
export const TOP_K_DEFAULT = 5;
export const CANDIDATE_POOL = 16;
export const EMBED_BATCH_SIZE = 16;

// 以下三项可由 env 覆盖，常量仅为默认值：
//   EMBEDDING_MODEL / EMBEDDING_ENDPOINT / RAG_DB_FILENAME（位于 .kda/rag/ 下）
export const DEFAULT_EMBEDDING_MODEL = "qwen3.7-text-embedding-flash";
export const DEFAULT_EMBEDDING_ENDPOINT =
  "https://llm-1keuhhcbmgcqsfvt.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";
export const DEFAULT_RAG_DB_FILENAME = "knowledge.db";
