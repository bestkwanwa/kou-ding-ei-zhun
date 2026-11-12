import { loadKnowledgeDocs } from "./loader.js";
import { chunkMarkdown } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import type { RagStore } from "./store.js";
import type { IngestSummary, RetrievedChunk } from "./types.js";
import { CANDIDATE_POOL, KEYWORD_WEIGHT, TOP_K_DEFAULT, VECTOR_WEIGHT } from "./types.js";

export interface RagServiceDeps {
  cwd: string;
  store: RagStore;
  embedder: Embedder;
}

export interface RagService {
  ingest(filterPath?: string): Promise<IngestSummary>;
  search(query: string, topK?: number): Promise<RetrievedChunk[]>;
  documentCount(): number;
  formatResults(chunks: RetrievedChunk[]): string;
}

export interface FusedHit {
  chunkId: number;
  score: number;
  vecScore?: number;
  kwScore?: number;
}

/** min-max 归一（单候选 = 1，多候选全同分 = 0.5） */
function normalize<T>(arr: T[], pick: (x: T) => number): { item: T; n: number }[] {
  if (arr.length === 0) return [];
  if (arr.length === 1) return [{ item: arr[0], n: 1 }];
  const vals = arr.map(pick);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return arr.map((item, i) => ({ item, n: max === min ? 0.5 : (vals[i] - min) / (max - min) }));
}

/** 混合融合：两路各自归一后按 0.7/0.3 加权求和，并集排序取 top-k（纯函数） */
export function fuseResults(
  vec: { chunkId: number; sim: number }[],
  kw: { chunkId: number; score: number }[],
  topK: number,
): FusedHit[] {
  const byId = new Map<number, FusedHit>();
  for (const { item, n } of normalize(vec, (x) => x.sim)) {
    byId.set(item.chunkId, { chunkId: item.chunkId, score: 0, vecScore: n });
  }
  for (const { item, n } of normalize(kw, (x) => x.score)) {
    const hit = byId.get(item.chunkId) ?? { chunkId: item.chunkId, score: 0 };
    hit.kwScore = n;
    byId.set(item.chunkId, hit);
  }
  for (const hit of byId.values()) {
    hit.score = VECTOR_WEIGHT * (hit.vecScore ?? 0) + KEYWORD_WEIGHT * (hit.kwScore ?? 0);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

const SNIPPET_CHARS = 600;

/** 编排 loader → chunker → embedder → store；工具层只做参数与格式化 */
export function createRagService(deps: RagServiceDeps): RagService {
  const { cwd, store, embedder } = deps;

  return {
    async ingest(filterPath?: string): Promise<IngestSummary> {
      const docs = loadKnowledgeDocs(cwd);
      const targets = filterPath ? docs.filter((d) => d.path === filterPath) : docs;
      if (filterPath && targets.length === 0) {
        throw new Error(`"${filterPath}" not found under .kda/knowledge/`);
      }

      const summary: IngestSummary = { scanned: targets.length, updated: 0, skipped: 0, chunks: 0, files: [], staleRemoved: 0 };
      for (const doc of targets) {
        if (store.findDocByPath(doc.path)?.hash === doc.hash) {
          summary.skipped++;
          continue;
        }
        const chunks = chunkMarkdown(doc.content);
        if (chunks.length === 0) {
          summary.skipped++;
          continue;
        }
        const vectors = await embedder.embed(chunks.map((c) => c.text));
        store.ensureVecTable(vectors[0].length, embedder.model);
        store.replaceDocument(doc, chunks, vectors);
        summary.updated++;
        summary.chunks += chunks.length;
        summary.files.push({ path: doc.path, chunks: chunks.length });
      }
      summary.staleRemoved = store.deleteStaleDocs(docs.map((d) => d.path));
      return summary;
    },

    async search(query: string, topK = TOP_K_DEFAULT): Promise<RetrievedChunk[]> {
      const [queryVec] = await embedder.embed([query]);
      const vecHits = store.searchVector(queryVec, CANDIDATE_POOL);
      const kwHits = store.searchKeyword(query, CANDIDATE_POOL);
      const fused = fuseResults(vecHits, kwHits, topK);
      if (fused.length === 0) return [];

      const rows = store.getChunks(fused.map((f) => f.chunkId));
      const byId = new Map(rows.map((r) => [r.id, r]));
      return fused
        .map((f): RetrievedChunk | undefined => {
          const row = byId.get(f.chunkId);
          if (!row) return undefined;
          return {
            chunkId: f.chunkId,
            docPath: row.path,
            heading: row.heading,
            text: row.text,
            score: f.score,
            vecScore: f.vecScore,
            kwScore: f.kwScore,
          };
        })
        .filter((x): x is RetrievedChunk => x !== undefined);
    },

    documentCount(): number {
      return store.documentCount();
    },

    formatResults(chunks: RetrievedChunk[]): string {
      if (chunks.length === 0) return "No matching content found in the knowledge base.";
      const items = chunks
        .map((c, i) => {
          const loc = c.heading ? `${c.docPath} — ${c.heading}` : c.docPath;
          const text = c.text.length > SNIPPET_CHARS ? c.text.slice(0, SNIPPET_CHARS) + "…" : c.text;
          return `## ${i + 1}. ${loc}\n${text}`;
        })
        .join("\n\n");
      return `Found ${chunks.length} chunk(s) from .kda/knowledge/:\n\n${items}\n\n---\n(Retrieved by hybrid search — verify accuracy against the codebase before relying on it.)`;
    },
  };
}
