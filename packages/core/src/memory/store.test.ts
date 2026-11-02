import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import { MAX_MEMORY_FILES, MAX_FILE_LINES, MAX_FILE_CHARS, MAX_INJECTION_CHARS } from "./types.js";

// --- Helpers ---

let dir: string;

function makeStore(): MemoryStore {
  dir = mkdtempSync(join(tmpdir(), "kda-memory-"));
  return new MemoryStore(dir);
}

function makeMemory(overrides: Partial<ReturnType<typeof base>> = {}) {
  const base = () => ({ name: "test-mem", type: "fact" as const, description: "a test memory", body: "Some details." });
  return { ...base(), ...overrides };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("MemoryStore.init", () => {
  it("creates the storage directory and is idempotent", () => {
    const store = makeStore();
    store.init();
    expect(existsSync(join(dir, ".kda", "memory"))).toBe(true);
    store.init(); // 幂等，不抛错
  });
});

describe("MemoryStore.upsert", () => {
  it("writes a frontmatter file and regenerates MEMORY.md index", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const raw = readFileSync(join(dir, ".kda", "memory", "test-mem.md"), "utf-8");
    expect(raw).toContain("name: test-mem");
    expect(raw).toContain("type: fact");
    expect(raw).toContain("Some details.");

    const index = readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8");
    expect(index).toContain("- [test-mem](test-mem.md) — a test memory");
  });

  it("overwrites in place and refreshes updated timestamp", async () => {
    const store = makeStore();
    const first = store.upsert(makeMemory());
    await new Promise((r) => setTimeout(r, 5));
    const second = store.upsert(makeMemory({ body: "Updated details." }));
    expect(second.updated > first.updated).toBe(true);

    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("Updated details.");
  });

  it("rejects invalid names (kebab-case whitelist, path traversal)", () => {
    const store = makeStore();
    expect(() => store.upsert(makeMemory({ name: "../evil" }))).toThrow(/Invalid memory name/);
    expect(() => store.upsert(makeMemory({ name: "Bad_Name" }))).toThrow(/Invalid memory name/);
    expect(() => store.upsert(makeMemory({ name: "" }))).toThrow(/Invalid memory name/);
  });

  it("rejects invalid type and empty/overlong description and empty body", () => {
    const store = makeStore();
    expect(() => store.upsert(makeMemory({ type: "random" as never }))).toThrow(/Invalid memory type/);
    expect(() => store.upsert(makeMemory({ description: "" }))).toThrow(/description is required/);
    expect(() => store.upsert(makeMemory({ description: "x".repeat(161) }))).toThrow(/description too long/);
    expect(() => store.upsert(makeMemory({ body: "  " }))).toThrow(/body is required/);
  });

  it(`rejects the ${MAX_MEMORY_FILES + 1}th new memory but allows overwriting at limit`, () => {
    const store = makeStore();
    for (let i = 0; i < MAX_MEMORY_FILES; i++) {
      store.upsert(makeMemory({ name: `mem-${i}` }));
    }
    expect(() => store.upsert(makeMemory({ name: "one-too-many" }))).toThrow(/Memory limit reached/);
    store.upsert(makeMemory({ name: "mem-0", body: "overwrite ok" }));
    expect(store.loadAll()).toHaveLength(MAX_MEMORY_FILES);
  });

  it("truncates body so the written file stays within line and char limits", () => {
    const store = makeStore();
    store.upsert(makeMemory({ body: "line\n".repeat(300) }));
    const raw = readFileSync(join(dir, ".kda", "memory", "test-mem.md"), "utf-8");
    expect(raw.split("\n").length).toBeLessThanOrEqual(MAX_FILE_LINES + 1); // +1 尾随换行产生的空元素

    store.upsert(makeMemory({ name: "wide", body: "x".repeat(6000) }));
    const wide = readFileSync(join(dir, ".kda", "memory", "wide.md"), "utf-8");
    expect(wide.length).toBeLessThanOrEqual(MAX_FILE_CHARS + 1);
  });
});

describe("MemoryStore.delete / clear", () => {
  it("deletes a memory and updates the index; returns false when missing", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    expect(store.delete("test-mem")).toBe(true);
    expect(existsSync(join(dir, ".kda", "memory", "test-mem.md"))).toBe(false);
    expect(readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8")).not.toContain("test-mem");
    expect(store.delete("test-mem")).toBe(false);
    expect(store.delete("../evil")).toBe(false);
  });

  it("clears all memories and keeps the index file", () => {
    const store = makeStore();
    store.upsert(makeMemory({ name: "a" }));
    store.upsert(makeMemory({ name: "b" }));
    expect(store.clear()).toBe(2);
    expect(store.loadAll()).toHaveLength(0);
    expect(existsSync(join(dir, ".kda", "memory", "MEMORY.md"))).toBe(true);
    expect(store.clear()).toBe(0);
  });
});

describe("MemoryStore.loadAll", () => {
  it("tolerates human-edited files without frontmatter", () => {
    const store = makeStore();
    const memDir = join(dir, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "handwritten.md"), "Just plain markdown.\n", "utf-8");
    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("handwritten");
    expect(all[0].type).toBe("fact");
    expect(all[0].body).toContain("Just plain markdown.");
  });

  it("returns [] when the directory does not exist", () => {
    const store = makeStore();
    expect(store.loadAll()).toEqual([]);
  });
});

describe("MemoryStore.buildInjectionText", () => {
  it("returns empty string with no memories", () => {
    const store = makeStore();
    expect(store.buildInjectionText()).toBe("");
  });

  it("includes header, index lines and file bodies", () => {
    const store = makeStore();
    store.upsert(makeMemory({ name: "build-system", description: "pnpm workspaces", body: "Run `pnpm -r build`." }));
    const text = store.buildInjectionText();
    expect(text).toContain("## Project Memory");
    expect(text).toContain("- [build-system](build-system.md) — pnpm workspaces");
    expect(text).toContain("### build-system");
    expect(text).toContain("Run `pnpm -r build`.");
  });

  it(`caps total length at ${MAX_INJECTION_CHARS} chars, dropping whole trailing files`, () => {
    const store = makeStore();
    const bigBody = "x".repeat(3900);
    for (let i = 0; i < 6; i++) {
      store.upsert(makeMemory({ name: `big-${i}`, description: `big ${i}`, body: bigBody }));
    }
    const text = store.buildInjectionText();
    expect(text.length).toBeLessThanOrEqual(MAX_INJECTION_CHARS + 100); // 预留 omitted 提示行
    expect(text).toMatch(/more memor(y|ies) omitted/);
    expect(text).toContain("### big-0");
    expect(text).not.toContain("### big-5");
  });
});
