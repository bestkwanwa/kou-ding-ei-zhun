import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledgeDocs } from "./loader.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-rag-loader-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("loadKnowledgeDocs", () => {
  it("collects .md files recursively with relative paths and content hashes", () => {
    const cwd = makeCwd();
    const root = join(cwd, ".kda", "knowledge");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.md"), "# A\n\n内容甲", "utf-8");
    writeFileSync(join(root, "sub", "b.md"), "# B\n\n内容乙", "utf-8");

    const docs = loadKnowledgeDocs(cwd);
    expect(docs.map((d) => d.path)).toEqual(["a.md", join("sub", "b.md")]);
    expect(docs[0].content).toContain("内容甲");
    expect(docs[0].hash).toHaveLength(64); // sha256 hex
    expect(docs[0].hash).not.toBe(docs[1].hash);
  });

  it("ignores non-markdown files", () => {
    const cwd = makeCwd();
    const root = join(cwd, ".kda", "knowledge");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "notes.txt"), "text", "utf-8");
    writeFileSync(join(root, "ok.MD"), "# ok", "utf-8"); // 大小写不敏感
    expect(loadKnowledgeDocs(cwd)).toHaveLength(1);
  });

  it("returns [] when the knowledge directory is missing or empty", () => {
    const cwd = makeCwd();
    expect(loadKnowledgeDocs(cwd)).toEqual([]);
    mkdirSync(join(cwd, ".kda", "knowledge"), { recursive: true });
    expect(loadKnowledgeDocs(cwd)).toEqual([]);
  });
});
