import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRagService, fuseResults } from "./service.js";
import { RagStore } from "./store.js";
import type { Embedder } from "./embedder.js";

// --- Helpers ---

let dir: string;

/** 确定性向量：按关键词映射到正交基，用于无网络的检索测试 */
function makeFakeEmbedder(): Embedder {
  const basis: Record<string, number[]> = {
    数据库: [1, 0, 0],
    网络: [0, 1, 0],
    部署: [0, 0, 1],
  };
  const embed = async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => {
      for (const [key, vec] of Object.entries(basis)) {
        if (t.includes(key)) return vec;
      }
      return [0.5, 0.5, 0.5];
    });
  return { embed, dims: 3, model: "fake-model" };
}

function makeService(): ReturnType<typeof createRagService> {
  dir = mkdtempSync(join(tmpdir(), "kda-rag-service-"));
  const store = new RagStore(join(dir, "knowledge.db"));
  store.init();
  return createRagService({ cwd: dir, store, embedder: makeFakeEmbedder() });
}

function writeDoc(name: string, content: string): void {
  mkdirSync(join(dir, ".kda", "knowledge"), { recursive: true });
  writeFileSync(join(dir, ".kda", "knowledge", name), content, "utf-8");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("fuseResults", () => {
  it("weights vector 0.7 and keyword 0.3 over min-max normalized scores", () => {
    const fused = fuseResults(
      [
        { chunkId: 1, sim: 1.0 },
        { chunkId: 2, sim: 0.5 },
      ],
      [
        { chunkId: 2, score: 3.0 },
        { chunkId: 1, score: 1.0 },
      ],
      5,
    );
    // chunk1: vec=1.0, kw=0.0 → 0.7；chunk2: vec=0.0, kw=1.0 → 0.3
    expect(fused[0]).toMatchObject({ chunkId: 1, score: closeTo(0.7) });
    expect(fused[1]).toMatchObject({ chunkId: 2, score: closeTo(0.3) });
  });

  it("keeps hits found by only one side", () => {
    const fused = fuseResults([{ chunkId: 1, sim: 0.9 }], [], 5);
    expect(fused).toHaveLength(1);
    expect(fused[0].vecScore).toBe(1); // 单候选归一为 1
    expect(fused[0].kwScore).toBeUndefined();
  });

  it("returns all-equal scores as 0.5 and slices to top-k", () => {
    const vec = [1, 2, 3].map((chunkId) => ({ chunkId, sim: 0.42 }));
    const fused = fuseResults(vec, [], 2);
    expect(fused).toHaveLength(2);
    expect(fused[0].score).toBeCloseTo(0.35, 10); // 0.7 * 0.5
  });
});

function closeTo(expected: number) {
  return { asymmetricMatch: (actual: number) => Math.abs(actual - expected) < 1e-9 };
}

describe("RagService", () => {
  it("ingest indexes documents and skips unchanged on re-run", async () => {
    const service = makeService();
    writeDoc("db.md", "## 数据库\n\n数据库连接池上限为 20");
    writeDoc("net.md", "## 网络\n\n网络超时时间 30 秒");

    const first = await service.ingest();
    expect(first).toMatchObject({ scanned: 2, updated: 2, skipped: 0, staleRemoved: 0 });
    expect(first.chunks).toBeGreaterThanOrEqual(2);

    const second = await service.ingest();
    expect(second).toMatchObject({ scanned: 2, updated: 0, skipped: 2 });

    writeDoc("db.md", "## 数据库\n\n数据库连接池上限改为 50");
    const third = await service.ingest();
    expect(third).toMatchObject({ scanned: 2, updated: 1, skipped: 1 });
  });

  it("ingest with an empty knowledge dir is a no-op that still reports stale cleanup", async () => {
    const service = makeService();
    writeDoc("tmp.md", "临时文档内容");
    await service.ingest();
    rmSync(join(dir, ".kda", "knowledge", "tmp.md"));
    const s = await service.ingest();
    expect(s).toMatchObject({ scanned: 0, updated: 0, staleRemoved: 1 });
  });

  it("ingest removes stale documents", async () => {
    const service = makeService();
    writeDoc("tmp.md", "临时文档内容");
    await service.ingest();
    rmSync(join(dir, ".kda", "knowledge", "tmp.md"));
    const s = await service.ingest();
    expect(s.staleRemoved).toBe(1);
    expect(service.documentCount()).toBe(0);
  });

  it("search returns chunks matched by both vector and keyword paths, docPath attached", async () => {
    const service = makeService();
    writeDoc("db.md", "## 数据库\n\n数据库连接池上限为 20");
    writeDoc("net.md", "## 网络\n\n网络超时时间 30 秒");
    await service.ingest();

    const results = await service.search("数据库连接池", 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docPath).toBe("db.md");
    expect(results[0].heading).toBe("数据库");
    expect(results[0].text).toContain("连接池");
  });

  it("search returns [] for an empty index", async () => {
    const service = makeService();
    // 有表无数据：借 ingest 后删文件再 ingest 清空
    writeDoc("x.md", "占位内容");
    await service.ingest();
    rmSync(join(dir, ".kda", "knowledge", "x.md"));
    await service.ingest();
    expect(await service.search("任意", 3)).toEqual([]);
  });

  it("formatResults renders numbered chunks with source and verify hint", async () => {
    const service = makeService();
    writeDoc("db.md", "## 数据库\n\n数据库连接池上限为 20");
    await service.ingest();
    const results = await service.search("数据库", 1);
    const text = service.formatResults(results);
    expect(text).toContain("## 1. db.md — 数据库");
    expect(text).toContain("verify");
  });
});
