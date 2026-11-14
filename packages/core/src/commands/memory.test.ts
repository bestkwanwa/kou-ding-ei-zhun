import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  store.upsert({ type: "dynamic", slug: "toolchain", description: "pnpm workspaces", body: "Run `pnpm -r build`." });
  store.upsert({ type: "user", slug: "pref", description: "replies in Chinese", body: "用户希望用中文回复。" });
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
    expect(out).toContain("dynamic-toolchain");
    expect(out).toContain("(dynamic)");
    expect(out).toContain("user-pref");
  });

  it("list on empty store reports no memories", () => {
    const ctx = makeCtx();
    expect(memoryCommand.execute("list", ctx)).toContain("No memories saved");
  });

  it("show prints a single memory in full", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    const out = memoryCommand.execute("show dynamic-toolchain", ctx);
    expect(out).toContain("name: dynamic-toolchain");
    expect(out).toContain("type: dynamic");
    expect(out).toContain("Run `pnpm -r build`.");
  });

  it("show with unknown name or missing arg is helpful", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    expect(memoryCommand.execute("show nope", ctx)).toContain('not found');
    expect(memoryCommand.execute("show", ctx)).toContain("Usage: /memory show <name>");
  });

  it("show records lastRead and accepts a filename argument", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    const out = memoryCommand.execute("show dynamic-toolchain.md", ctx);
    expect(out).toContain("name: dynamic-toolchain");
    expect(out).toContain("lastRead:");
    const raw = readFileSync(join(dir, ".kda", "memory", "dynamic-toolchain.md"), "utf-8");
    expect(raw).toContain("lastRead:");
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

  it("lint on empty store reports no memories", () => {
    const ctx = makeCtx();
    expect(memoryCommand.execute("lint", ctx)).toContain("No memories saved");
  });

  it("lint reports no issues on a fresh store", () => {
    const ctx = makeCtx();
    seedMemories(ctx);
    expect(memoryCommand.execute("lint", ctx)).toContain("no issues found");
  });

  it("lint surfaces stale, broken-path and duplicate findings", () => {
    const ctx = makeCtx();
    const memDir = join(dir, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    writeFileSync(
      join(memDir, "dynamic-sprint.md"),
      `---\nname: dynamic-sprint\ntype: dynamic\ndescription: sprint refs docs/gone.md\nupdated: ${old}\n---\nsprint docs at docs/gone.md\n`,
      "utf-8",
    );
    writeFileSync(
      join(memDir, "user-deploy.md"),
      `---\nname: user-deploy\ntype: user\ndescription: d\nupdated: ${now}\n---\nb\n`,
      "utf-8",
    );
    writeFileSync(
      join(memDir, "dynamic-deploy.md"),
      `---\nname: dynamic-deploy\ntype: dynamic\ndescription: d\nupdated: ${now}\n---\nb\n`,
      "utf-8",
    );

    const out = memoryCommand.execute("lint", ctx);
    expect(out).toContain("Stale (1)");
    expect(out).toContain("dynamic-sprint.md");
    expect(out).toContain("docs/gone.md");
    expect(out).toContain("Broken paths (1)");
    expect(out).toContain("Duplicate slugs (1)");
    expect(out).toContain("user-deploy.md");
    expect(out).toContain("Report-only");
  });

  it("help / unknown action prints usage", () => {
    const ctx = makeCtx();
    for (const args of ["help", "explode"]) {
      expect(memoryCommand.execute(args, ctx)).toContain("Usage: /memory");
    }
    expect(memoryCommand.execute("help", ctx)).toContain("lint");
  });
});
