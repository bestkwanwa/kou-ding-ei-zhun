import { describe, it, expect, afterEach, vi } from "vitest";
import { createEmbedder } from "./embedder.js";

// --- Helpers ---

/** 构造阿里 MaaS 实测响应形态：output.embeddings 条目带 index（无 text_index） */
function mockFetch(responses: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- Subject ---

describe("createEmbedder", () => {
  it("parses the Aliyun MaaS shape (output.embeddings with index field) and preserves order", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    mockFetch([
      {
        output: {
          embeddings: [
            { embedding: [0.1, 0.2], index: 1 },
            { embedding: [0.3, 0.4], index: 0 },
          ],
        },
      },
    ]);
    const embedder = createEmbedder();
    const out = await embedder.embed(["第一句", "第二句"]);
    expect(out).toEqual([
      [0.3, 0.4], // index 0 归位到第一位
      [0.1, 0.2],
    ]);
    expect(embedder.dims).toBe(2);
  });

  it("falls back to the OpenAI response shape (data[].index)", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    mockFetch([{ data: [{ embedding: [1, 0], index: 0 }] }]);
    const embedder = createEmbedder();
    expect(await embedder.embed(["hello"])).toEqual([[1, 0]]);
  });

  it("rejects when DASHSCOPE_API_KEY is missing", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    mockFetch([]);
    const embedder = createEmbedder();
    await expect(embedder.embed(["x"])).rejects.toThrow(/DASHSCOPE_API_KEY is not set/);
  });

  it("rejects with status and detail on HTTP errors", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota exceeded", { status: 429 })),
    );
    const embedder = createEmbedder();
    await expect(embedder.embed(["x"])).rejects.toThrow(/Embedding API 429: quota exceeded/);
  });

  it("rejects on unexpected response shape", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    mockFetch([{ foo: "bar" }]);
    const embedder = createEmbedder();
    await expect(embedder.embed(["x"])).rejects.toThrow(/Unexpected embedding API response/);
  });

  it("sends batches of EMBED_BATCH_SIZE with DashScope body shape", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    const batch1 = { output: { embeddings: Array.from({ length: 16 }, (_, i) => ({ embedding: [1, 0], index: i })) } };
    const batch2 = { output: { embeddings: [{ embedding: [0, 1], index: 0 }] } };
    const fetchMock = mockFetch([batch1, batch2]);
    const embedder = createEmbedder();
    const out = await embedder.embed(Array(17).fill("text")); // 16 + 1 两批
    expect(out).toHaveLength(17);
    expect(out[0]).toEqual([1, 0]);
    expect(out[16]).toEqual([0, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input.texts).toHaveLength(16);
    expect(body.model).toBe("qwen3.7-text-embedding-flash");
  });
});
