import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCommand } from "./skill.js";
import { SkillManager } from "../skills/index.js";

// --- Helpers ---

let dir: string;

function makeCtx(): { cwd: string; skills: SkillManager } {
  dir = mkdtempSync(join(tmpdir(), "kda-skill-cmd-"));
  return { cwd: dir, skills: new SkillManager(dir) };
}

function seedSkills(ctx: { cwd: string }): void {
  const base = join(ctx.cwd, ".kda", "skills");
  mkdirSync(join(base, "deploy"), { recursive: true });
  writeFileSync(join(base, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nbody\n", "utf-8");
  mkdirSync(join(base, "review"), { recursive: true });
  writeFileSync(join(base, "review", "SKILL.md"), "---\ndescription: Review the PR\n---\nbody\n", "utf-8");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("/skill command", () => {
  it("defaults to list and shows all skills with availability markers", () => {
    const ctx = makeCtx();
    seedSkills(ctx);
    const out = skillCommand.execute("", ctx);
    expect(out).toContain("Project skills (2)");
    expect(out).toContain("deploy");
    expect(out).toContain("review");
    expect(out).toContain("[available]");
  });

  it("list marks loaded skills", () => {
    const ctx = makeCtx();
    seedSkills(ctx);
    ctx.skills.load("deploy");
    const out = skillCommand.execute("list", ctx);
    expect(out).toContain("[loaded]");
  });

  it("list on empty store reports no skills", () => {
    const ctx = makeCtx();
    expect(skillCommand.execute("list", ctx)).toContain("No skills found");
    expect(skillCommand.execute("list", ctx)).toContain(".kda/skills/<name>/SKILL.md");
  });

  it("load activates the skill (state visible on the manager)", () => {
    const ctx = makeCtx();
    seedSkills(ctx);
    const out = skillCommand.execute("load deploy", ctx);
    expect(out).toContain('Skill "deploy" loaded');
    expect(ctx.skills.isLoaded("deploy")).toBe(true);
  });

  it("load with unknown name or missing arg is helpful", () => {
    const ctx = makeCtx();
    seedSkills(ctx);
    expect(skillCommand.execute("load nope", ctx)).toContain('Skill "nope" not found');
    expect(skillCommand.execute("load nope", ctx)).toContain("Existing: deploy, review");
    expect(skillCommand.execute("load", ctx)).toContain("Usage: /skill load <name>");
  });

  it("unload deactivates; distinguishes not-loaded from not-found", () => {
    const ctx = makeCtx();
    seedSkills(ctx);
    ctx.skills.load("deploy");
    expect(skillCommand.execute("unload deploy", ctx)).toContain('Skill "deploy" unloaded');
    expect(ctx.skills.isLoaded("deploy")).toBe(false);
    expect(skillCommand.execute("unload deploy", ctx)).toContain("is not loaded");
    expect(skillCommand.execute("unload nope", ctx)).toContain('Skill "nope" not found');
  });

  it("path prints the storage directory", () => {
    const ctx = makeCtx();
    expect(skillCommand.execute("path", ctx)).toBe(join(dir, ".kda", "skills"));
  });

  it("help / unknown action prints usage", () => {
    const ctx = makeCtx();
    for (const args of ["help", "explode"]) {
      expect(skillCommand.execute(args, ctx)).toContain("Usage: /skill");
    }
    expect(skillCommand.execute("help", ctx)).toContain("unload");
  });

  it("guards when skills manager is not injected", () => {
    expect(skillCommand.execute("list", { cwd: "/tmp" })).toContain("Skills are not available");
  });
});
