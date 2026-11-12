export { RagStore } from "./store.js";
export { createRagService, fuseResults } from "./service.js";
export type { RagService, RagServiceDeps, FusedHit } from "./service.js";
export { createEmbedder } from "./embedder.js";
export type { Embedder } from "./embedder.js";
export { chunkMarkdown } from "./chunker.js";
export { loadKnowledgeDocs } from "./loader.js";
export type { RagDoc, RagChunk, RetrievedChunk, IngestSummary } from "./types.js";
export {
  CHUNK_MAX_TOKENS,
  EST_CHARS_PER_TOKEN,
  VECTOR_WEIGHT,
  KEYWORD_WEIGHT,
  TOP_K_DEFAULT,
  CANDIDATE_POOL,
  EMBED_BATCH_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_RAG_DB_FILENAME,
} from "./types.js";
