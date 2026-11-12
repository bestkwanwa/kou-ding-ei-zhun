import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRagTools } from "./rag-tools.js";
import { createRagService } from "../rag/service.js";
import { RagStore } from "../rag/store.js";
import type { Embedder } from "../rag/embedder.js";

// --- Helpers ---

let dir: string;

function makeTools(): { ingestDocsTool: ReturnType<typeof createRagTools>["ingestDocsTool"]; searchKnowledgeTool: ReturnType<typeof createRagTools>["searchKnowledgeTool"] } {
  dir = mkdtempSync(join(tmpdir(), "kda-rag-tools-"));
  const store = new RagStore(join(dir, "knowledge.db"));
  store.init();
  const fakeEmbedder: Embedder = {
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    dims: 3,
    model: "fake",
  };
  const service = createRagService({ cwd: dir, store, embedder: fakeEmbedder });
  return createRagTools(service);
}

function writeDoc(name: string, content: string): void {
  mkdirSync(join(dir, ".kda", "knowledge"), { recursive: true });
  writeFileSync(join(dir, ".kda", "knowledge", name), content, "utf-8");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("rag tools", () => {
  it("ingest_docs indexes files and reports a summary", async () => {
    const { ingestDocsTool } = makeTools();
    writeDoc("guide.md", "## 指南\n\n部署流程说明");
    const out = await ingestDocsTool.execute({}, { cwd: dir });
    expect(out).toContain("Ingested 1 file(s)");
    expect(out).toContain("guide.md");
  });

  it("ingest_docs with no documents returns a helpful Error", async () => {
    const { ingestDocsTool } = makeTools();
    const out = await ingestDocsTool.execute({}, { cwd: dir });
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain(".kda/knowledge/");
  });

  it("ingest_docs with an unknown path filters nothing and errors", async () => {
    const { ingestDocsTool } = makeTools();
    writeDoc("guide.md", "内容");
    const out = await ingestDocsTool.execute({ path: "nope.md" }, { cwd: dir });
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("not found");
  });

  it("search_knowledge before ingest prompts to ingest first", async () => {
    const { searchKnowledgeTool } = makeTools();
    const out = await searchKnowledgeTool.execute({ query: "部署" }, { cwd: dir });
    expect(out).toContain("knowledge base is empty");
  });

  it("search_knowledge returns formatted results after ingest", async () => {
    const tools = makeTools();
    writeDoc("guide.md", "## 部署\n\n部署使用蓝绿发布策略");
    await tools.ingestDocsTool.execute({}, { cwd: dir });
    const out = await tools.searchKnowledgeTool.execute({ query: "蓝绿" }, { cwd: dir });
    expect(out).toContain("guide.md");
    expect(out).toContain("蓝绿发布策略");
  });

  it("search_knowledge requires a query", async () => {
    const { searchKnowledgeTool } = makeTools();
    const out = await searchKnowledgeTool.execute({ query: "  " }, { cwd: dir });
    expect(out.startsWith("Error:")).toBe(true);
  });
});
