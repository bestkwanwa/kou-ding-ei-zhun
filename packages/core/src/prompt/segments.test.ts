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

  it("returns index and bodies when memories exist", () => {
    const cwd = makeCwd();
    new MemoryStore(cwd).upsert({
      name: "build-system", type: "project", description: "pnpm workspaces", body: "Run `pnpm -r build`.",
    });
    const text = memory({ cwd, registry: new ToolRegistry() });
    expect(text).toContain("## Project Memory");
    expect(text).toContain("- [build-system](build-system.md) — pnpm workspaces");
    expect(text).toContain("Run `pnpm -r build`.");
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
