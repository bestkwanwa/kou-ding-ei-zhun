import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCommand } from "./memory.js";
import { MemoryStore } from "../memory/index.js";

// --- Helpers ---

let dir: string;

function makeCtx() {
  dir = mkdtempSync(join(tmpdir(), "kda-memory-cmd-"));
  return { cwd: dir };
}

function seedMemories(ctx: { cwd: string }) {
  const store = new MemoryStore(ctx.cwd);
  store.upsert({ name: "build-system", type: "project", description: "pnpm workspaces", body: "Run `pnpm -r build`." });
  store.upsert({ name: "user-pref", type: "preference", description: "replies in Chinese", body: "用户希望用中文回复。" });
  return store;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("/memory command", () => {
  it("defaults to list and shows all memories", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    const out = memoryCommand.execute("", ctx);
    expect(out).toContain("Project memory (2)");
    expect(out).toContain("build-system");
    expect(out).toContain("(project)");
    expect(out).toContain("user-pref");
  });

  it("list on empty store reports no memories", () => {
    const ctx = makeCtx();
    expect(memoryCommand.execute("list", ctx)).toContain("No memories saved");
  });

  it("show prints a single memory in full", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    const out = memoryCommand.execute("show build-system", ctx);
    expect(out).toContain("name: build-system");
    expect(out).toContain("type: project");
    expect(out).toContain("Run `pnpm -r build`.");
  });

  it("show with unknown name or missing arg is helpful", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    expect(memoryCommand.execute("show nope", ctx)).toContain('not found');
    expect(memoryCommand.execute("show", ctx)).toContain("Usage: /memory show <name>");
  });

  it("delete removes a memory", () => {
    const ctx = makeCtx();
    const store = seedMemories(ctx);
    const out = memoryCommand.execute("delete user-pref", ctx);
    expect(out).toContain("Deleted memory: user-pref");
    expect(store.loadAll()).toHaveLength(1);
  });

  it("clear wipes everything", () => {
    const ctx = makeCtx();
    const store = seedMemories(ctx);
    expect(memoryCommand.execute("clear", ctx)).toContain("Cleared 2 memories");
    expect(store.loadAll()).toHaveLength(0);
  });

  it("path prints the storage directory", () => {
    const ctx = makeCtx();
    const out = memoryCommand.execute("path", ctx);
    expect(out).toBe(join(dir, ".kda", "memory"));
  });

  it("help / unknown action prints usage", () => {
    const ctx = makeCtx();
    for (const args of ["help", "explode"]) {
      expect(memoryCommand.execute(args, ctx)).toContain("Usage: /memory");
    }
  });
});
