import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunker.js";
import { CHUNK_MAX_TOKENS, EST_CHARS_PER_TOKEN } from "./types.js";

const maxChars = CHUNK_MAX_TOKENS * EST_CHARS_PER_TOKEN;

// --- Subject ---

describe("chunkMarkdown", () => {
  it("keeps short paragraphs as single chunks", () => {
    const chunks = chunkMarkdown("第一段。\n\n第二段。");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ text: "第一段。", heading: "" });
    expect(chunks[1]).toMatchObject({ text: "第二段。", heading: "" });
  });

  it("drops blank paragraphs and assigns increasing ordinals", () => {
    const chunks = chunkMarkdown("A\n\n\n\nB");
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });

  it("carries the nearest heading as context; pure-heading paragraphs produce no chunk", () => {
    const chunks = chunkMarkdown("# 标题一\n\n正文甲\n\n## 小节\n\n正文乙");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe("标题一");
    expect(chunks[1].heading).toBe("小节");
  });

  it("splits an oversized paragraph by sentences, all chunks within the limit", () => {
    const sentence = "这是一句刚好长度的测试句子。"; // 13 chars
    const paragraph = sentence.repeat(Math.ceil((maxChars + 100) / sentence.length));
    const chunks = chunkMarkdown(paragraph);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
      expect(c.text.startsWith("这是")).toBe(true); // 不切断句子
    }
    expect(chunks.map((c) => c.text).join("")).toBe(paragraph);
  });

  it("hard-splits a single monster sentence by characters", () => {
    const monster = "咻".repeat(maxChars * 2 + 10);
    const chunks = chunkMarkdown(monster);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(monster);
  });

  it("handles empty and whitespace-only input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("\n\n  \n\n")).toEqual([]);
  });
});
