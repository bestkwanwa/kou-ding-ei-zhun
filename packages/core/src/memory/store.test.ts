import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import { MAX_MEMORY_FILES, MAX_FILE_LINES, MAX_FILE_CHARS, MAINTENANCE_MARKER_ID } from "./types.js";

// --- Helpers ---

let dir: string;

function makeStore(): MemoryStore {
  dir = mkdtempSync(join(tmpdir(), "kda-memory-"));
  return new MemoryStore(dir);
}

function makeMemory(overrides: Partial<{ type: "user" | "feedback" | "dynamic" | "resource"; slug: string; description: string; body: string }> = {}) {
  return {
    type: "feedback" as const,
    slug: "test-mem",
    description: "a test memory",
    body: "Some details.",
    ...overrides,
  };
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
  it("auto-prefixes the type and writes file + index", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const raw = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    expect(raw).toContain("name: feedback-test-mem");
    expect(raw).toContain("type: feedback");
    expect(raw).toContain("Some details.");

    const index = readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8");
    expect(index).toContain("- [feedback-test-mem](feedback-test-mem.md) — a test memory");
  });

  it("strips an already-prefixed slug (idempotent prefix)", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    store.upsert(makeMemory({ slug: "feedback-test-mem", body: "Updated." }));
    expect(store.loadAll()).toHaveLength(1);
    expect(store.loadAll()[0].body).toBe("Updated.");
    expect(existsSync(join(dir, ".kda", "memory", "feedback-feedback-test-mem.md"))).toBe(false);
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

  it("rejects invalid types and slugs that make an invalid id", () => {
    const store = makeStore();
    expect(() => store.upsert(makeMemory({ type: "project" as never }))).toThrow(/Invalid memory type/);
    expect(() => store.upsert(makeMemory({ slug: "../evil" }))).toThrow(/Invalid memory name/);
    expect(() => store.upsert(makeMemory({ slug: "" }))).toThrow(/slug is required/);
  });

  it("rejects empty/overlong description and empty body", () => {
    const store = makeStore();
    expect(() => store.upsert(makeMemory({ description: "" }))).toThrow(/description is required/);
    expect(() => store.upsert(makeMemory({ description: "x".repeat(161) }))).toThrow(/description too long/);
    expect(() => store.upsert(makeMemory({ body: "  " }))).toThrow(/body is required/);
  });

  it(`rejects the ${MAX_MEMORY_FILES + 1}th new memory but allows overwriting at limit`, () => {
    const store = makeStore();
    for (let i = 0; i < MAX_MEMORY_FILES; i++) {
      store.upsert(makeMemory({ slug: `mem-${i}` }));
    }
    expect(() => store.upsert(makeMemory({ slug: "one-too-many" }))).toThrow(/Memory limit reached/);
    store.upsert(makeMemory({ slug: "mem-0", body: "overwrite ok" }));
    expect(store.loadAll()).toHaveLength(MAX_MEMORY_FILES);
  });

  it("truncates body so the written file stays within line and char limits", () => {
    const store = makeStore();
    store.upsert(makeMemory({ body: "line\n".repeat(300) }));
    const raw = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    expect(raw.split("\n").length).toBeLessThanOrEqual(MAX_FILE_LINES + 1); // +1 尾随换行产生的空元素

    store.upsert(makeMemory({ slug: "wide", body: "x".repeat(6000) }));
    const wide = readFileSync(join(dir, ".kda", "memory", "feedback-wide.md"), "utf-8");
    expect(wide.length).toBeLessThanOrEqual(MAX_FILE_CHARS + 1);
  });
});

describe("MemoryStore.read / delete / clear", () => {
  it("reads a memory by full id", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const m = store.read("feedback-test-mem");
    expect(m?.id).toBe("feedback-test-mem");
    expect(m?.body).toBe("Some details.");
    expect(store.read("nope")).toBeNull();
    expect(store.read("../evil")).toBeNull();
  });

  it("deletes a memory and updates the index; returns false when missing", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    expect(store.delete("feedback-test-mem")).toBe(true);
    expect(existsSync(join(dir, ".kda", "memory", "feedback-test-mem.md"))).toBe(false);
    expect(readFileSync(join(dir, ".kda", "memory", "MEMORY.md"), "utf-8")).not.toContain("feedback-test-mem");
    expect(store.delete("feedback-test-mem")).toBe(false);
    expect(store.delete("../evil")).toBe(false);
  });

  it("clears all memories and keeps the index file", () => {
    const store = makeStore();
    store.upsert(makeMemory({ slug: "a" }));
    store.upsert(makeMemory({ slug: "b" }));
    expect(store.clear()).toBe(2);
    expect(store.loadAll()).toHaveLength(0);
    expect(existsSync(join(dir, ".kda", "memory", "MEMORY.md"))).toBe(true);
    expect(store.clear()).toBe(0);
  });
});

describe("MemoryStore.loadAll", () => {
  it("tolerates human-edited files: type from filename prefix or degraded to dynamic", () => {
    const store = makeStore();
    const memDir = join(dir, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "handwritten.md"), "Just plain markdown.\n", "utf-8");
    writeFileSync(join(memDir, "user-notes.md"), "Note without frontmatter.\n", "utf-8");
    writeFileSync(join(memDir, "legacy-project.md"), "---\nname: legacy-project\ntype: project\n---\nold taxonomy\n", "utf-8");

    const all = store.loadAll();
    const byId = Object.fromEntries(all.map((m) => [m.id, m]));

    expect(byId["handwritten"].type).toBe("dynamic"); // 无前缀 → 降级
    expect(byId["user-notes"].type).toBe("user"); // 前缀识别
    expect(byId["legacy-project"].type).toBe("dynamic"); // 旧类型非法 → 降级
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

  it("injects ONLY the index plus usage hints, never bodies", () => {
    const store = makeStore();
    store.upsert(makeMemory({ type: "dynamic", slug: "toolchain", description: "pnpm workspaces", body: "Run `pnpm -r build`." }));
    const text = store.buildInjectionText();
    expect(text).toContain("## Project Memory");
    expect(text).toContain("- [dynamic-toolchain](dynamic-toolchain.md) — pnpm workspaces");
    expect(text).toContain("use the memory tool's read action");
    expect(text).toContain("Memories are clues, not facts");
    // 正文绝不进入注入
    expect(text).not.toContain("Run `pnpm -r build`.");
  });
});

describe("MemoryStore.read lastRead tracking", () => {
  it("records lastRead on explicit read and keeps the original content", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const m = store.read("feedback-test-mem");
    expect(m?.lastRead).toBeTruthy();
    const raw = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    expect(raw).toContain("lastRead:");
    expect(raw).toContain("name: feedback-test-mem");
    expect(raw).toContain("Some details.");
    expect(store.loadAll()[0].lastRead).toBeTruthy();
  });

  it("advances lastRead on repeated reads", async () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const first = store.read("feedback-test-mem")!.lastRead!;
    await new Promise((r) => setTimeout(r, 10));
    const second = store.read("feedback-test-mem")!.lastRead!;
    expect(second > first).toBe(true);
  });

  it("accepts a filename (trailing .md) in read and delete", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    expect(store.read("feedback-test-mem.md")?.id).toBe("feedback-test-mem");
    expect(store.delete("feedback-test-mem.md")).toBe(true);
    expect(existsSync(join(dir, ".kda", "memory", "feedback-test-mem.md"))).toBe(false);
  });

  it("loadAll and injection never write lastRead", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const before = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    store.loadAll();
    store.buildInjectionText();
    const after = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("MemoryStore.upsert lastRead carry-over", () => {
  it("carries lastRead over on overwrite; brand-new ids have none", () => {
    const store = makeStore();
    store.upsert(makeMemory());
    const readAt = store.read("feedback-test-mem")!.lastRead!;
    const saved = store.upsert(makeMemory({ body: "Updated." }));
    expect(saved.lastRead).toBe(readAt);
    const raw = readFileSync(join(dir, ".kda", "memory", "feedback-test-mem.md"), "utf-8");
    expect(raw).toContain(`lastRead: ${readAt}`);

    store.upsert(makeMemory({ slug: "fresh" }));
    expect(readFileSync(join(dir, ".kda", "memory", "feedback-fresh.md"), "utf-8")).not.toContain("lastRead:");
  });
});

describe("MemoryStore maintenance marker & listEntries", () => {
  it("excludes the maintenance marker from loadAll, index and clear", () => {
    const store = makeStore();
    store.init();
    const memDir = join(dir, ".kda", "memory");
    writeFileSync(
      join(memDir, `${MAINTENANCE_MARKER_ID}.md`),
      `---\nname: ${MAINTENANCE_MARKER_ID}\ntype: dynamic\ndescription: marker\nupdated: 2026-11-01T00:00:00.000Z\n---\nreport\n`,
      "utf-8",
    );
    store.upsert(makeMemory());
    expect(store.loadAll().map((m) => m.id)).toEqual(["feedback-test-mem"]);
    expect(readFileSync(join(memDir, "MEMORY.md"), "utf-8")).not.toContain("memory-maintenance");
    expect(store.clear()).toBe(1);
    expect(existsSync(join(memDir, `${MAINTENANCE_MARKER_ID}.md`))).toBe(true);
  });

  it("allows overwriting the marker at the file cap (filename-based isNew)", () => {
    const store = makeStore();
    for (let i = 0; i < MAX_MEMORY_FILES; i++) {
      store.upsert(makeMemory({ slug: `mem-${i}` }));
    }
    expect(() =>
      store.upsert({ type: "dynamic", slug: "memory-maintenance", description: "pass", body: "report" }),
    ).not.toThrow();
    expect(store.loadAll()).toHaveLength(MAX_MEMORY_FILES);
  });

  it("listEntries exposes filenames for name-mismatch detection", () => {
    const store = makeStore();
    const memDir = join(dir, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "user-foo.md"),
      "---\nname: user-bar\ntype: user\ndescription: d\nupdated: 2026-11-01T00:00:00.000Z\n---\nbody\n",
      "utf-8",
    );
    const entries = store.listEntries();
    expect(entries[0].filename).toBe("user-foo.md");
    expect(entries[0].memory.id).toBe("user-bar");
  });
});
