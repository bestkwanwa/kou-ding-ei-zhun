import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTool } from "./memory.js";
import { MemoryStore } from "../memory/index.js";

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
  });

  it("save action writes the memory file and index", async () => {
    const tool = makeTool();
    const out = await tool.execute(
      { action: "save", name: "build-system", type: "project", description: "pnpm workspaces", body: "Run `pnpm -r build`." },
      makeCtx(),
    );
    expect(out).toContain("Memory saved: build-system (project)");
    expect(existsSync(join(dir, ".kda", "memory", "build-system.md"))).toBe(true);
    expect(readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8")).toContain("build-system");
  });

  it("save returns Error when required fields are missing or invalid", async () => {
    const tool = makeTool();
    const noType = await tool.execute(
      { action: "save", name: "x", description: "d", body: "b" }, makeCtx(),
    );
    expect(noType.startsWith("Error:")).toBe(true);

    const badName = await tool.execute(
      { action: "save", name: "../evil", type: "fact", description: "d", body: "b" }, makeCtx(),
    );
    expect(badName.startsWith("Error:")).toBe(true);
    expect(badName).toContain("Invalid memory name");
  });

  it("delete action removes an existing memory", async () => {
    const tool = makeTool();
    await tool.execute(
      { action: "save", name: "to-delete", type: "fact", description: "d", body: "b" }, makeCtx(),
    );
    const out = await tool.execute({ action: "delete", name: "to-delete" }, makeCtx());
    expect(out).toContain("Memory deleted: to-delete");
    expect(existsSync(join(dir, ".kda", "memory", "to-delete.md"))).toBe(false);
  });

  it("delete of a missing memory returns Error listing existing ones", async () => {
    const tool = makeTool();
    await tool.execute(
      { action: "save", name: "exists", type: "fact", description: "d", body: "b" }, makeCtx(),
    );
    const out = await tool.execute({ action: "delete", name: "nope" }, makeCtx());
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("exists");
  });

  it("unknown action returns Error", async () => {
    const tool = makeTool();
    const out = await tool.execute({ action: "explode", name: "x" }, makeCtx());
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("unknown action");
  });
});
