import "dotenv/config";
import { DEFAULT_EMBEDDING_ENDPOINT, DEFAULT_EMBEDDING_MODEL, EMBED_BATCH_SIZE } from "./types.js";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  /** 首次调用后可知；未调用过为 undefined */
  readonly dims: number | undefined;
  /** 实际使用的模型名（env EMBEDDING_MODEL 或默认值） */
  readonly model: string;
}

interface DashScopeResponse {
  // 阿里 MaaS 端点在 output.embeddings 内使用 OpenAI 风格的 index 字段（无 text_index），两者都兼容
  output?: { embeddings?: { embedding: number[]; index?: number; text_index?: number }[] };
  data?: { embedding: number[]; index: number }[];
}

/**
 * 阿里云 MaaS 文本向量客户端（DashScope 形态，兼容 OpenAI 响应）。
 * env：DASHSCOPE_API_KEY（必需，调用时校验）、EMBEDDING_MODEL、EMBEDDING_ENDPOINT。
 */
export function createEmbedder(): Embedder {
  let dims: number | undefined;
  const model = process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  return {
    get dims() {
      return dims;
    },
    get model() {
      return model;
    },
    async embed(texts: string[]): Promise<number[][]> {
      const apiKey = process.env.DASHSCOPE_API_KEY;
      if (!apiKey) {
        throw new Error("DASHSCOPE_API_KEY is not set — add it to .env to enable embeddings");
      }
      const endpoint = process.env.EMBEDDING_ENDPOINT ?? DEFAULT_EMBEDDING_ENDPOINT;

      const out: number[][] = new Array(texts.length);
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: { texts: batch } }),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          throw new Error(`Embedding API ${res.status}: ${detail}`);
        }
        const data = (await res.json()) as DashScopeResponse;
        const entries =
          data.output?.embeddings?.map((e) => ({ i: e.index ?? e.text_index ?? 0, v: e.embedding })) ??
          data.data?.map((e) => ({ i: e.index, v: e.embedding }));
        if (!entries || entries.length !== batch.length) {
          throw new Error(`Unexpected embedding API response (got ${entries?.length ?? 0} of ${batch.length})`);
        }
        for (const e of entries) {
          out[i + e.i] = e.v;
        }
        dims = dims ?? entries[0].v.length;
      }
      return out;
    },
  };
}
