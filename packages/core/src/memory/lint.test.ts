import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPathRefs, lintMemory, formatLintReport } from "./lint.js";
import { MAINTENANCE_MARKER_ID } from "./types.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-lint-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-13T00:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function seedMemory(cwd: string, filename: string, frontmatterLines: string[], body: string) {
  const memDir = join(cwd, ".kda", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, filename), `---\n${frontmatterLines.join("\n")}\n---\n${body}\n`, "utf-8");
}

// --- Subject ---

describe("extractPathRefs", () => {
  it("collects backtick spans and path-like tokens, deduped", () => {
    const refs = extractPathRefs("See `packages/core/src` and docs/guide.md, plus ./local and /abs/path and src/a/b (v2).");
    expect(refs).toContain("packages/core/src");
    expect(refs).toContain("docs/guide.md");
    expect(refs).toContain("./local");
    expect(refs).toContain("/abs/path");
    expect(refs).toContain("src/a/b");
    // 反引号片段与裸 token 归一后去重
    expect(refs.filter((r) => r === "packages/core/src")).toHaveLength(1);
  });

  it("skips URLs, home paths, versions, scheme ids and prose slashes", () => {
    const refs = extractPathRefs("https://x.dev/a/b and ftp://y/z then ~/secret/a, 1.2.3, node:fs, and/or, true/false.");
    expect(refs).toEqual([]);
  });
});

describe("lintMemory.stale", () => {
  it("flags per-type TTL breaches using max(lastRead, updated)", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "dynamic-sprint.md",
      ["name: dynamic-sprint", "type: dynamic", "description: d", `updated: ${iso(40)}`, `lastRead: ${iso(35)}`],
      "sprint state");
    seedMemory(cwd, "resource-board.md",
      ["name: resource-board", "type: resource", "description: d", `updated: ${iso(20)}`, `lastRead: ${iso(10)}`],
      "board");
    seedMemory(cwd, "user-profile.md",
      ["name: user-profile", "type: user", "description: d", `updated: ${iso(100)}`],
      "profile");

    const report = lintMemory(cwd, NOW);
    const staleIds = report.stale.map((f) => f.id);
    expect(staleIds).toContain("dynamic-sprint"); // 35d > TTL 30，且以较晚的 lastRead 为准
    expect(staleIds).not.toContain("resource-board"); // 10d < TTL 14
    expect(staleIds).not.toContain("user-profile"); // 100d < TTL 180（回退 updated）
    const sprint = report.stale.find((f) => f.id === "dynamic-sprint")!;
    expect(sprint.usedField).toBe("lastRead");
    expect(sprint.daysSince).toBe(35);
    expect(sprint.ttlDays).toBe(30);
  });

  it("uses the later of lastRead/updated; a recent read keeps an old write fresh", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "feedback-rule.md",
      ["name: feedback-rule", "type: feedback", "description: d", `updated: ${iso(300)}`, `lastRead: ${iso(3)}`],
      "rule");
    seedMemory(cwd, "user-legacy.md",
      ["name: user-legacy", "type: user", "description: d", `updated: ${iso(200)}`],
      "legacy");

    const report = lintMemory(cwd, NOW);
    expect(report.stale.map((f) => f.id)).toEqual(["user-legacy"]); // 200d > 180
    expect(report.stale[0].usedField).toBe("updated");
  });

  it("treats memories with no parseable timestamps as stale (usedField none)", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "handwritten.md", [], "no frontmatter at all");
    const report = lintMemory(cwd, NOW);
    expect(report.stale[0].usedField).toBe("none");
    expect(report.stale[0].daysSince).toBe(Infinity);
  });
});

describe("lintMemory.missingPaths", () => {
  it("flags referenced paths that do not exist and keeps existing ones", () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "alive.ts"), "export {};", "utf-8");
    seedMemory(cwd, "resource-docs.md",
      ["name: resource-docs", "type: resource", "description: " + "d", `updated: ${iso(1)}`],
      "See docs/gone.md and src/alive.ts.");

    const report = lintMemory(cwd, NOW);
    expect(report.missingPaths.map((f) => f.path)).toEqual(["docs/gone.md"]);
    expect(report.missingPaths[0].filename).toBe("resource-docs.md");
    expect(report.missingPaths[0].preview).toContain("See docs/gone.md");
  });
});

describe("lintMemory.duplicateSlugs / nameMismatches", () => {
  it("flags the same slug under different types", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "user-deploy.md",
      ["name: user-deploy", "type: user", "description: d", `updated: ${iso(1)}`], "a");
    seedMemory(cwd, "dynamic-deploy.md",
      ["name: dynamic-deploy", "type: dynamic", "description: d", `updated: ${iso(1)}`], "b");

    const report = lintMemory(cwd, NOW);
    expect(report.duplicateSlugs).toHaveLength(1);
    expect(report.duplicateSlugs[0].slug).toBe("deploy");
    expect(report.duplicateSlugs[0].filenames).toEqual(["dynamic-deploy.md", "user-deploy.md"]); // 文件名排序
  });

  it("flags frontmatter name ≠ filename", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "user-foo.md",
      ["name: user-bar", "type: user", "description: d", "updated: 2026-11-01T00:00:00.000Z"], "b");
    const report = lintMemory(cwd, NOW);
    expect(report.nameMismatches).toEqual([{ filename: "user-foo.md", frontmatterName: "user-bar" }]);
  });
});

describe("lintMemory total & marker exclusion", () => {
  it("reports 0 for an empty store and ignores the maintenance marker file", () => {
    const cwd = makeCwd();
    expect(lintMemory(cwd, NOW).total).toBe(0);
    seedMemory(cwd, `${MAINTENANCE_MARKER_ID}.md`,
      ["name: " + MAINTENANCE_MARKER_ID, "type: dynamic", "description: marker", `updated: ${iso(1)}`],
      "report");
    expect(lintMemory(cwd, NOW).total).toBe(0);
  });
});

describe("formatLintReport", () => {
  it("renders a plain, model-facing report with previews and a fix hint", () => {
    const cwd = makeCwd();
    seedMemory(cwd, "dynamic-sprint.md",
      ["name: dynamic-sprint", "type: dynamic", "description: d", `updated: ${iso(40)}`],
      "Sprint goal is the memory upgrade");
    const out = formatLintReport(lintMemory(cwd, NOW));
    expect(out).toContain("Memory lint: 1 memory scanned");
    expect(out).toContain("Stale (1)");
    expect(out).toContain("dynamic-sprint.md");
    expect(out).toContain("TTL 30d");
    expect(out).toContain("Sprint goal is the memory upgrade");
    expect(out).toContain("Report-only");
  });

  it("handles the empty and clean cases", () => {
    const cwd = makeCwd();
    expect(formatLintReport(lintMemory(cwd, NOW))).toContain("no memories saved");
    seedMemory(cwd, "user-profile.md",
      ["name: user-profile", "type: user", "description: d", `updated: ${iso(1)}`], "profile");
    expect(formatLintReport(lintMemory(cwd, NOW))).toContain("no issues found");
  });
});
