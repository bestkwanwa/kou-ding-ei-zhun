import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory, memoryMaintenance, skillIndex, loadedSkills } from "./segments.js";
import { createSystemPromptBuilder } from "./index.js";
import { ToolRegistry } from "../tools/registry.js";
import { MemoryStore } from "../memory/index.js";
import { SkillManager } from "../skills/index.js";

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

describe("memoryMaintenance segment", () => {
  it("returns empty when not due (gate 1)", () => {
    const cwd = makeCwd();
    expect(memoryMaintenance({ cwd, registry: new ToolRegistry() })).toBe("");
    expect(memoryMaintenance({ cwd, registry: new ToolRegistry(), memoryMaintenanceDue: false })).toBe("");
  });

  it("renders the four-phase directive when due and unrecorded", () => {
    const cwd = makeCwd();
    const text = memoryMaintenance({ cwd, registry: new ToolRegistry(), memoryMaintenanceDue: true });
    expect(text).toContain("Memory Maintenance Due");
    expect(text).toContain("Phase 1: Locate");
    expect(text).toContain("Phase 4: Record");
    expect(text).toContain("slug=memory-maintenance");
    expect(text).toContain("last run: never");
    expect(text).toContain("take the filename");
  });

  it("disappears once a fresh marker exists on disk (gate 2)", () => {
    const cwd = makeCwd();
    const memDir = join(cwd, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "dynamic-memory-maintenance.md"),
      `---\nname: dynamic-memory-maintenance\ntype: dynamic\ndescription: marker\nupdated: ${new Date().toISOString()}\n---\nreport\n`,
      "utf-8",
    );
    expect(memoryMaintenance({ cwd, registry: new ToolRegistry(), memoryMaintenanceDue: true })).toBe("");
  });
});

describe("skill segments", () => {
  it("skillIndex returns empty string without a skills manager or skills dir", () => {
    const cwd = makeCwd();
    expect(skillIndex({ cwd, registry: new ToolRegistry() })).toBe("");
    expect(skillIndex({ cwd, registry: new ToolRegistry(), skills: new SkillManager(cwd) })).toBe("");
  });

  it("skillIndex injects the index (no bodies) and loadedSkills injects only loaded bodies", () => {
    const cwd = makeCwd();
    const skillDir = join(cwd, ".kda", "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Deploy the app\n---\nRun pnpm deploy now\n",
      "utf-8",
    );
    const skills = new SkillManager(cwd);

    const ctx = { cwd, registry: new ToolRegistry(), skills };
    expect(skillIndex(ctx)).toContain("- deploy — Deploy the app");
    expect(skillIndex(ctx)).not.toContain("Run pnpm deploy now");
    expect(loadedSkills(ctx)).toBe(""); // 未激活

    skills.load("deploy");
    expect(loadedSkills(ctx)).toContain("## Active Skill: deploy");
    expect(loadedSkills(ctx)).toContain("Run pnpm deploy now");
    expect(skillIndex(ctx)).toContain("[active]");
  });
});

describe("createSystemPromptBuilder segment order", () => {
  it("registers segments in order: core → tool-guide → lazy-tools → skill-index → loaded-skills → memory → memory-maintenance → session-context", () => {
    const cwd = makeCwd();
    const builder = createSystemPromptBuilder({ cwd, registry: new ToolRegistry() });
    const order = builder
      .debug()
      .split("\n")
      .map((l) => l.trim().split(":")[0]);
    expect(order).toEqual([
      "core",
      "tool-guide",
      "lazy-tools",
      "skill-index",
      "loaded-skills",
      "memory",
      "memory-maintenance",
      "session-context",
    ]);
  });

  it("TOOL_GUIDE core tools line includes memory and rag tools", () => {
    const cwd = makeCwd();
    const prompt = createSystemPromptBuilder({ cwd, registry: new ToolRegistry() }).build();
    expect(prompt).toContain("search_tools, memory, ingest_docs, search_knowledge.");
  });
});
