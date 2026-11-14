import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "./manager.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-skills-"));
  return dir;
}

function seedSkill(cwd: string, slug: string, content: string): void {
  const skillDir = join(cwd, ".kda", "skills", slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
}

const DEPLOY = `---
name: deploy
description: Deploy the app to production
---
1. Run tests
2. Run \`pnpm deploy\`
`;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("SkillManager.list", () => {
  it("returns [] when the skills directory is missing", () => {
    expect(new SkillManager(makeCwd()).list()).toEqual([]);
  });

  it("scans skill directories sorted by slug and skips non-directories and bad names", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "review", `---\nname: review\ndescription: Review the PR\n---\nbody\n`);
    seedSkill(cwd, "deploy", DEPLOY);
    // 无 SKILL.md 的目录、非法目录名、散落的 md 文件都跳过
    mkdirSync(join(cwd, ".kda", "skills", "empty-dir"), { recursive: true });
    mkdirSync(join(cwd, ".kda", "skills", "Bad_Name"), { recursive: true });
    writeFileSync(join(cwd, ".kda", "skills", "loose.md"), "x", "utf-8");

    const all = new SkillManager(cwd).list();
    expect(all.map((s) => s.slug)).toEqual(["deploy", "review"]);
  });

  it("defaults name to slug and derives description from the sanitized first body line", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", `# Deploy the app\nRun pnpm deploy now. Then verify.\n`);
    const s = new SkillManager(cwd).list()[0];
    expect(s.name).toBe("deploy");
    expect(s.description).toBe("Deploy the app");
  });

  it("derives description skipping frontmatter/fence garbage and caps it at 160 chars", () => {
    const cwd = makeCwd();
    const long = "x".repeat(300);
    seedSkill(cwd, "deploy", `\`\`\`bash\n${long}\n\`\`\`\n`);
    const s = new SkillManager(cwd).list()[0];
    expect(s.description).toBe(long.slice(0, 160));
  });

  it("falls back to (no description) for an empty body and caps explicit descriptions", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "empty", `---\nname: empty\n---\n\n`);
    seedSkill(cwd, "long", `---\ndescription: ${"y".repeat(300)}\n---\nbody\n`);
    const all = new SkillManager(cwd).list();
    expect(all.find((s) => s.slug === "empty")!.description).toBe("(no description)");
    expect(all.find((s) => s.slug === "long")!.description).toHaveLength(160);
  });

  it("registers skills with unclosed frontmatter using slug identity", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", `---\nname: deploy\ndescription: never closed\nRun pnpm deploy\n`);
    const s = new SkillManager(cwd).list()[0];
    expect(s.slug).toBe("deploy");
    expect(s.name).toBe("deploy"); // frontmatter 未闭合 → 全文作 body，name 兜底为 slug
    expect(s.body).toContain("never closed");
  });

  it("truncates body at read time (500 lines / 10000 chars) without touching the file", () => {
    const cwd = makeCwd();
    const body = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    seedSkill(cwd, "big", `---\ndescription: d\n---\n${body}\n`);
    const s = new SkillManager(cwd).list()[0];
    expect(s.body.split("\n")).toHaveLength(500);
    expect(s.body.length).toBeLessThanOrEqual(10000);
    const raw = readFileSync(join(cwd, ".kda", "skills", "big", "SKILL.md"), "utf-8");
    expect(raw).toContain("line 599"); // 文件不动
  });
});

describe("SkillManager.resolve", () => {
  it("resolves by slug, by whitespace-free name alias, case-insensitively", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", `---\nname: deploy-to-vercel\ndescription: d\n---\nbody\n`);
    const mgr = new SkillManager(cwd);
    expect(mgr.resolve("deploy")!.slug).toBe("deploy");
    expect(mgr.resolve("deploy-to-vercel")!.slug).toBe("deploy");
    expect(mgr.resolve("DEPLOY")!.slug).toBe("deploy");
    expect(mgr.resolve("nope")).toBeUndefined();
    expect(mgr.resolve("")).toBeUndefined();
  });

  it("ignores name aliases containing spaces (slug still works)", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", `---\nname: deploy to vercel\ndescription: d\n---\nbody\n`);
    const mgr = new SkillManager(cwd);
    expect(mgr.resolve("deploy to vercel")).toBeUndefined();
    expect(mgr.resolve("deploy")!.slug).toBe("deploy");
  });
});

describe("SkillManager load/unload", () => {
  it("load activates, unload deactivates; unknown names return false", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    const mgr = new SkillManager(cwd);

    expect(mgr.load("nope")).toBe(false);
    expect(mgr.load("deploy")).toBe(true);
    expect(mgr.isLoaded("deploy")).toBe(true);
    expect(mgr.getLoadedSkills()).toEqual(["deploy"]);

    expect(mgr.unload("deploy")).toBe(true);
    expect(mgr.isLoaded("deploy")).toBe(false);
    expect(mgr.unload("deploy")).toBe(false); // 本未激活
    expect(mgr.unload("nope")).toBe(false);
  });

  it("keeps activation order in getLoadedSkills and self-heals deleted skill dirs", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    seedSkill(cwd, "review", `---\ndescription: d\n---\nreview body\n`);
    const mgr = new SkillManager(cwd);
    mgr.load("review");
    mgr.load("deploy");
    expect(mgr.getLoadedSkills()).toEqual(["review", "deploy"]);

    rmSync(join(cwd, ".kda", "skills", "review"), { recursive: true, force: true });
    expect(mgr.getLoadedSkills()).toEqual(["deploy"]); // 与当前扫描求交，自愈出集
  });
});

describe("SkillManager.buildIndexInjection", () => {
  it("returns empty string when no skills exist", () => {
    expect(new SkillManager(makeCwd()).buildIndexInjection()).toBe("");
  });

  it("lists slug + description with [active] only for loaded skills", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    seedSkill(cwd, "review", `---\ndescription: Review the PR\n---\nreview body\n`);
    const mgr = new SkillManager(cwd);
    mgr.load("deploy");

    const text = mgr.buildIndexInjection();
    expect(text).toContain("## Project Skills");
    expect(text).toContain("- deploy — Deploy the app to production [active]");
    expect(text).toContain("- review — Review the PR");
    expect(text).not.toContain("review — Review the PR [active]");
    expect(text).toContain("/skill load");
  });

  it("drops whole lines with an omission notice when over the cap", () => {
    const cwd = makeCwd();
    for (let i = 0; i < 30; i++) {
      seedSkill(cwd, `skill-${String(i).padStart(2, "0")}`, `---\ndescription: ${"d".repeat(100)}\n---\nbody\n`);
    }
    const text = new SkillManager(cwd).buildIndexInjection();
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/\.\.\. \(\d+ more skills omitted\)/);
  });
});

describe("SkillManager.buildLoadedInjection", () => {
  it("returns empty string when nothing is loaded", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    expect(new SkillManager(cwd).buildLoadedInjection()).toBe("");
  });

  it("injects each loaded skill under its own header, in activation order", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    seedSkill(cwd, "review", `---\ndescription: d\n---\nreview body\n`);
    const mgr = new SkillManager(cwd);
    mgr.load("review");
    mgr.load("deploy");

    const text = mgr.buildLoadedInjection();
    expect(text).toContain("## Active Skill: review\nreview body");
    expect(text).toContain("## Active Skill: deploy\n1. Run tests");
    expect(text.indexOf("## Active Skill: review")).toBeLessThan(text.indexOf("## Active Skill: deploy"));
  });
});

describe("SkillManager.activateForExecution", () => {
  it("activates and returns a forward message referencing the prompt section", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    const mgr = new SkillManager(cwd);

    const forward = mgr.activateForExecution("deploy", "--prod")!;
    expect(forward).toContain('Execute the skill "deploy" now');
    expect(forward).toContain('"## Active Skill: deploy"');
    expect(forward).toContain("Arguments: --prod");
    expect(mgr.isLoaded("deploy")).toBe(true);
  });

  it("omits the Arguments sentence when args are empty and returns null for unknown skills", () => {
    const cwd = makeCwd();
    seedSkill(cwd, "deploy", DEPLOY);
    const mgr = new SkillManager(cwd);

    const forward = mgr.activateForExecution("deploy", "   ")!;
    expect(forward).not.toContain("Arguments");
    expect(mgr.activateForExecution("nope", "x")).toBeNull();
  });
});
