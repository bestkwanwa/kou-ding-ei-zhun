import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTool } from "./memory.js";
import { MemoryStore, MAX_FILE_CHARS } from "../memory/index.js";

// --- Helpers ---

let dir: string;

/** 按装配层的方式构造工具：store 外显构造 + init，经参数注入工厂 */
function makeTool() {
  dir = mkdtempSync(join(tmpdir(), "kda-memory-tool-"));
  const store = new MemoryStore(dir);
  store.init();
  return createMemoryTool(store);
}

function makeCtx() {
  return { cwd: dir };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("memory tool", () => {
  it("is wired with an injected, initialized store", () => {
    const tool = makeTool();
    expect(existsSync(join(dir, ".kda", "memory"))).toBe(true);
    expect(tool.name).toBe("memory");
    expect(tool.maxResultLength).toBe(MAX_FILE_CHARS + 1_000); // read 需容纳整篇正文 + 头部
  });

  it("save with slug auto-prefixes the type", async () => {
    const tool = makeTool();
    const out = await tool.execute(
      { action: "save", type: "feedback", slug: "no-npm", description: "不要用 npm", body: "统一用 pnpm。" },
      makeCtx(),
    );
    expect(out).toContain("Memory saved: feedback-no-npm (feedback)");
    expect(existsSync(join(dir, ".kda", "memory", "feedback-no-npm.md"))).toBe(true);
    expect(readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8")).toContain("feedback-no-npm");
  });

  it("save with an already-prefixed slug is idempotent", async () => {
    const tool = makeTool();
    await tool.execute(
      { action: "save", type: "feedback", slug: "no-npm", description: "d", body: "b" }, makeCtx(),
    );
    await tool.execute(
      { action: "save", type: "feedback", slug: "feedback-no-npm", description: "d", body: "b2" }, makeCtx(),
    );
    expect(existsSync(join(dir, ".kda", "memory", "feedback-feedback-no-npm.md"))).toBe(false);
  });

  it("save falls back to a title-like name as description (one-shot success)", async () => {
    const tool = makeTool();
    // 模型典型误用：标题进 name、漏 description——应一次成功而非报错重试
    const out = await tool.execute(
      { action: "save", type: "user", slug: "prefers-typescript", name: "用户偏好 TypeScript", body: "新代码默认用 TS。" },
      makeCtx(),
    );
    expect(out).toContain("Memory saved: user-prefers-typescript");
    const raw = readFileSync(join(dir, ".kda", "memory", "user-prefers-typescript.md"), "utf-8");
    expect(raw).toContain("description: 用户偏好 TypeScript");
  });

  it("save with an id-shaped name derives description from the body (one-shot success)", async () => {
    const tool = makeTool();
    // 模型另一形态：name 填自己拼的完整 id、漏 description——应从 body 首句派生摘要，一次成功
    const out = await tool.execute(
      {
        action: "save", type: "user", slug: "prefers-typescript",
        name: "user-prefers-typescript",
        body: "用户偏好 TypeScript 而非 JavaScript；新代码默认使用 TS。",
      },
      makeCtx(),
    );
    expect(out).toContain("Memory saved: user-prefers-typescript");
    const raw = readFileSync(join(dir, ".kda", "memory", "user-prefers-typescript.md"), "utf-8");
    expect(raw).toContain("description: 用户偏好 TypeScript 而非 JavaScript；");
  });

  it("save returns Error when required fields are missing or invalid", async () => {
    const tool = makeTool();
    const noType = await tool.execute(
      { action: "save", slug: "x", description: "d", body: "b" }, makeCtx(),
    );
    expect(noType.startsWith("Error:")).toBe(true);

    const badType = await tool.execute(
      { action: "save", type: "project", slug: "x", description: "d", body: "b" }, makeCtx(),
    );
    expect(badType.startsWith("Error:")).toBe(true);
    expect(badType).toContain("Invalid memory type");
  });

  it("read returns the full content without truncating large bodies", async () => {
    const tool = makeTool();
    const bigBody = "x".repeat(3_800);
    await tool.execute(
      { action: "save", type: "dynamic", slug: "refactor", description: "进行中", body: bigBody }, makeCtx(),
    );
    const out = await tool.execute({ action: "read", name: "dynamic-refactor" }, makeCtx());
    expect(out).toContain("name: dynamic-refactor");
    expect(out).toContain("type: dynamic");
    expect(out.length).toBeGreaterThan(3_800); // 正文完整返回
    expect(out).toContain(bigBody);
  });

  it("read/delete of a missing memory returns Error listing existing ids", async () => {
    const tool = makeTool();
    await tool.execute(
      { action: "save", type: "user", slug: "elvis", description: "d", body: "b" }, makeCtx(),
    );
    const readOut = await tool.execute({ action: "read", name: "nope" }, makeCtx());
    expect(readOut.startsWith("Error:")).toBe(true);
    expect(readOut).toContain("user-elvis");

    const delOut = await tool.execute({ action: "delete", name: "nope" }, makeCtx());
    expect(delOut.startsWith("Error:")).toBe(true);
  });

  it("delete removes an existing memory by full id", async () => {
    const tool = makeTool();
    await tool.execute(
      { action: "save", type: "user", slug: "elvis", description: "d", body: "b" }, makeCtx(),
    );
    const out = await tool.execute({ action: "delete", name: "user-elvis" }, makeCtx());
    expect(out).toContain("Memory deleted: user-elvis");
    expect(existsSync(join(dir, ".kda", "memory", "user-elvis.md"))).toBe(false);
  });

  it("unknown action returns Error", async () => {
    const tool = makeTool();
    const out = await tool.execute({ action: "explode", name: "x" }, makeCtx());
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("unknown action");
  });
});
