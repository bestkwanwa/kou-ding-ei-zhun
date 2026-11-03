import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "./segments.js";
import { createSystemPromptBuilder } from "./index.js";
import { ToolRegistry } from "../tools/registry.js";
import { MemoryStore } from "../memory/index.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-segments-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("memory segment", () => {
  it("returns empty string when no memories exist", () => {
    const cwd = makeCwd();
    expect(memory({ cwd, registry: new ToolRegistry() })).toBe("");
  });

  it("returns index-only injection (with hints, no bodies) when memories exist", () => {
    const cwd = makeCwd();
    new MemoryStore(cwd).upsert({
      type: "dynamic", slug: "toolchain", description: "pnpm workspaces", body: "Run `pnpm -r build`.",
    });
    const text = memory({ cwd, registry: new ToolRegistry() });
    expect(text).toContain("## Project Memory");
    expect(text).toContain("- [dynamic-toolchain](dynamic-toolchain.md) — pnpm workspaces");
    expect(text).toContain("use the memory tool's read action");
    expect(text).toContain("clues, not facts");
    expect(text).not.toContain("Run `pnpm -r build`."); // 正文不注入
  });
});

describe("createSystemPromptBuilder segment order", () => {
  it("registers segments in order: core → tool-guide → lazy-tools → memory → session-context", () => {
    const cwd = makeCwd();
    const builder = createSystemPromptBuilder({ cwd, registry: new ToolRegistry() });
    const order = builder
      .debug()
      .split("\n")
      .map((l) => l.trim().split(":")[0]);
    expect(order).toEqual(["core", "tool-guide", "lazy-tools", "memory", "session-context"]);
  });

  it("TOOL_GUIDE core tools line includes memory", () => {
    const cwd = makeCwd();
    const prompt = createSystemPromptBuilder({ cwd, registry: new ToolRegistry() }).build();
    expect(prompt).toContain("search_tools, memory.");
  });
});
