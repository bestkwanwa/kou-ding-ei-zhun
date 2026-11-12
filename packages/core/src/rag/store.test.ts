import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagStore } from "./store.js";
import type { RagChunk, RagDoc } from "./types.js";

// --- Helpers ---

let dir: string;

function makeStore(): RagStore {
  dir = mkdtempSync(join(tmpdir(), "kda-rag-store-"));
  const store = new RagStore(join(dir, "knowledge.db"));
  store.init();
  return store;
}

function makeDoc(path = "doc.md", content = "内容"): RagDoc {
  return { path, content, hash: `hash-${path}-${content}` };
}

function makeChunks(texts: string[]): RagChunk[] {
  return texts.map((text, ordinal) => ({ ordinal, heading: "H", text }));
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("RagStore", () => {
  it("replaceDocument writes chunks with fts + vec rows and finds them back", () => {
    const store = makeStore();
    store.ensureVecTable(2, "test-model");
    const chunks = makeChunks(["数据库连接池配置", "网络超时重试策略"]);
    const vectors = [[1, 0], [0, 1]];
    store.replaceDocument(makeDoc(), chunks, vectors);

    expect(store.documentCount()).toBe(1);
    expect(store.findDocByPath("doc.md")?.hash).toBe("hash-doc.md-内容");

    const rows = store.getChunks([1, 2]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "doc.md", heading: "H", text: "数据库连接池配置" });
  });

  it("replaceDocument is idempotent: re-importing the same doc does not duplicate rows", () => {
    const store = makeStore();
    store.ensureVecTable(2, "test-model");
    const doc = makeDoc();
    store.replaceDocument(doc, makeChunks(["数据库连接池配置", "网络重试策略"]), [[1, 0], [0, 1]]);
    store.replaceDocument({ ...doc, hash: "hash-v2" }, makeChunks(["部署蓝绿发布"]), [[1, 0]]);

    expect(store.documentCount()).toBe(1);
    expect(store.findDocByPath("doc.md")?.hash).toBe("hash-v2");
    // 旧分块（含 fts/vec 行）已清理
    expect(store.getChunks(store.searchKeyword("连接池配置", 10).map((h) => h.chunkId))).toHaveLength(0);
    expect(store.getChunks(store.searchKeyword("蓝绿发布", 10).map((h) => h.chunkId))).toHaveLength(1);
  });

  it("searchVector returns nearest neighbors by cosine similarity", () => {
    const store = makeStore();
    store.ensureVecTable(2, "test-model");
    store.replaceDocument(makeDoc("a.md"), makeChunks(["甲"]), [[1, 0]]);
    store.replaceDocument(makeDoc("b.md"), makeChunks(["乙"]), [[0, 1]]);

    const hits = store.searchVector([1, 0], 2);
    expect(hits[0].sim).toBeGreaterThan(0.99);
    const top = store.getChunks([hits[0].chunkId])[0];
    expect(top.text).toBe("甲");
    expect(hits[1].sim).toBeLessThan(0.01); // 正交
  });

  it("searchVector returns [] before the vec table exists", () => {
    const store = makeStore();
    expect(store.searchVector([1, 0], 5)).toEqual([]);
  });

  it("searchKeyword matches CJK text via trigram", () => {
    const store = makeStore();
    store.ensureVecTable(2, "test-model");
    store.replaceDocument(makeDoc(), makeChunks(["装饰器模式的核心是动态组合", "工厂模式负责创建对象"]), [[1, 0], [0, 1]]);

    const hits = store.searchKeyword("装饰器", 5);
    expect(hits).toHaveLength(1);
    expect(store.getChunks([hits[0].chunkId])[0].text).toContain("装饰器");
  });

  it("searchKeyword returns [] for empty query terms", () => {
    const store = makeStore();
    expect(store.searchKeyword("   ", 5)).toEqual([]);
  });

  it("deleteStaleDocs removes documents no longer present and returns the count", () => {
    const store = makeStore();
    store.ensureVecTable(2, "test-model");
    store.replaceDocument(makeDoc("keep.md"), makeChunks(["保留"]), [[1, 0]]);
    store.replaceDocument(makeDoc("gone.md"), makeChunks(["删除"]), [[0, 1]]);

    expect(store.deleteStaleDocs(["keep.md"])).toBe(1);
    expect(store.documentCount()).toBe(1);
    expect(store.findDocByPath("gone.md")).toBeNull();
    // 向量行也一并清理：全库 KNN 只剩 1 条
    expect(store.searchVector([0, 1], 5)).toHaveLength(1);
  });

  it("ensureVecTable resets everything when the model/dims change", () => {
    const store = makeStore();
    store.ensureVecTable(2, "model-a");
    store.replaceDocument(makeDoc(), makeChunks(["旧模型内容"]), [[1, 0]]);
    store.ensureVecTable(4, "model-b");

    expect(store.documentCount()).toBe(0);
    expect(store.searchVector([1, 0, 0, 0], 5)).toEqual([]);
  });
});
