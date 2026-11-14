import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryStore } from "./store.js";
import type { MemoryFile, MemoryType } from "./types.js";
import { MEMORY_TTL_DAYS } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATH_CHARS_RE = /^[\w./@+-]+$/;

export interface StaleFinding {
  id: string;
  filename: string;
  type: MemoryType;
  /** 判定依据；none = lastRead/updated 都缺失或无法解析 */
  usedField: "lastRead" | "updated" | "none";
  /** 判定所用时间戳（原样 ISO 字符串；none 时为空串） */
  usedAt: string;
  /** 距判定时间戳的天数（向下取整）；none 时为 Infinity */
  daysSince: number;
  ttlDays: number;
  /** 正文首行预览（供自动整理不逐条 read 就能决策） */
  preview: string;
}

export interface MissingPathFinding {
  id: string;
  filename: string;
  path: string;
  preview: string;
}

export interface DuplicateSlugFinding {
  slug: string;
  ids: string[];
  filenames: string[];
}

export interface NameMismatchFinding {
  filename: string;
  frontmatterName: string;
}

export interface MemoryLintReport {
  total: number;
  stale: StaleFinding[];
  missingPaths: MissingPathFinding[];
  duplicateSlugs: DuplicateSlugFinding[];
  nameMismatches: NameMismatchFinding[];
}

/**
 * 从文本中保守提取仓库路径引用（宁可漏报不可误报）：
 * - 反引号片段：作者显式标记为代码/路径，含 "/" 即采信（跳过 URL 与 ~ 开头）
 * - 裸 token：要求全为路径字符，且（根相对 / ../ ./ 或 含带点的段 或 ≥3 个非空段），
 *   以排除 "and/or" 这类普通散文
 */
export function extractPathRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    if (seen.has(raw)) return;
    seen.add(raw);
    refs.push(raw);
  };

  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1].trim();
    if (!s || /\s/.test(s) || !s.includes("/") || URL_RE.test(s) || s.startsWith("~")) continue;
    push(s);
  }

  for (const token of text.split(/\s+/)) {
    const s = token.replace(/^[([{"'`<]+/, "").replace(/[)\]}"'`>,;:.!]+$/, "");
    if (!s || !s.includes("/") || URL_RE.test(s) || s.startsWith("~")) continue;
    if (!PATH_CHARS_RE.test(s)) continue;
    const segments = s.split("/");
    const rooted = s.startsWith("/") || s.startsWith("./") || s.startsWith("../");
    const dotted = segments.some((seg) => seg.includes("."));
    const deep = segments.filter(Boolean).length >= 3;
    if (!rooted && !dotted && !deep) continue;
    push(s);
  }
  return refs;
}

/** 过期判定基准：max(lastRead, updated)，即「上一次读或写」取较晚者；都不可解析 → none */
function lastUsed(memory: MemoryFile): { usedField: StaleFinding["usedField"]; usedAt: string; usedMs: number } {
  const candidates: { usedField: "lastRead" | "updated"; usedAt: string; usedMs: number }[] = [];
  if (memory.lastRead) {
    const ms = Date.parse(memory.lastRead);
    if (!Number.isNaN(ms)) candidates.push({ usedField: "lastRead", usedAt: memory.lastRead, usedMs: ms });
  }
  if (memory.updated) {
    const ms = Date.parse(memory.updated);
    if (!Number.isNaN(ms)) candidates.push({ usedField: "updated", usedAt: memory.updated, usedMs: ms });
  }
  if (candidates.length === 0) return { usedField: "none", usedAt: "", usedMs: NaN };
  return candidates.reduce((a, b) => (b.usedMs > a.usedMs ? b : a));
}

/** 单行预览：正文首个非空行，压缩空白并截断 */
function preview(body: string, max = 120): string {
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * 记忆体检：过期（按类型保质期）/ 引用路径失效 / 跨类型重名 / name≠文件名。
 * 只报告，不修改，也不触发 lastRead（全程走 listEntries，不调 read）。
 */
export function lintMemory(cwd: string, now: Date = new Date()): MemoryLintReport {
  const entries = new MemoryStore(cwd).listEntries();
  const report: MemoryLintReport = {
    total: entries.length,
    stale: [],
    missingPaths: [],
    duplicateSlugs: [],
    nameMismatches: [],
  };
  const nowMs = now.getTime();
  const slugGroups = new Map<string, { id: string; filename: string }[]>();

  for (const { filename, memory } of entries) {
    const ttlDays = MEMORY_TTL_DAYS[memory.type];
    const used = lastUsed(memory);
    const stale = used.usedField === "none" || nowMs - used.usedMs > ttlDays * MS_PER_DAY;
    if (stale) {
      report.stale.push({
        id: memory.id,
        filename,
        type: memory.type,
        usedField: used.usedField,
        usedAt: used.usedAt,
        daysSince: used.usedField === "none" ? Infinity : Math.floor((nowMs - used.usedMs) / MS_PER_DAY),
        ttlDays,
        preview: preview(memory.body),
      });
    }

    for (const p of extractPathRefs(`${memory.description}\n${memory.body}`)) {
      if (!existsSync(resolve(cwd, p))) {
        report.missingPaths.push({ id: memory.id, filename, path: p, preview: preview(memory.body) });
      }
    }

    const slug = memory.id.startsWith(`${memory.type}-`) ? memory.id.slice(memory.type.length + 1) : memory.id;
    const group = slugGroups.get(slug) ?? [];
    group.push({ id: memory.id, filename });
    slugGroups.set(slug, group);

    if (filename.replace(/\.md$/, "") !== memory.id) {
      report.nameMismatches.push({ filename, frontmatterName: memory.id });
    }
  }

  for (const [slug, group] of slugGroups) {
    if (group.length > 1) {
      report.duplicateSlugs.push({
        slug,
        ids: group.map((g) => g.id),
        filenames: group.map((g) => g.filename),
      });
    }
  }
  return report;
}

/** 工具用的纯文本报告（含内容预览，供自动整理「定位」阶段一次扫描即够） */
export function formatLintReport(report: MemoryLintReport): string {
  if (report.total === 0) return "Memory lint: no memories saved.";
  const issues =
    report.stale.length + report.missingPaths.length + report.duplicateSlugs.length + report.nameMismatches.length;
  if (issues === 0) return `Memory lint: ${report.total} ${report.total === 1 ? "memory" : "memories"} scanned, no issues found.`;

  const parts = [
    `Memory lint: ${report.total} ${report.total === 1 ? "memory" : "memories"} scanned, ${issues} issue${issues === 1 ? "" : "s"} found.`,
  ];

  if (report.stale.length > 0) {
    parts.push(`\nStale (${report.stale.length}) — not read or written within the TTL for the type:`);
    for (const f of report.stale) {
      const since = f.usedField === "none"
        ? "no readable lastRead/updated timestamps"
        : `${f.daysSince}d since ${f.usedField} ${f.usedAt}`;
      parts.push(`- ${f.filename} (${f.type}, TTL ${f.ttlDays}d): ${since} — "${f.preview}"`);
    }
  }
  if (report.missingPaths.length > 0) {
    parts.push(
      `\nBroken path references (${report.missingPaths.length}) — referenced paths no longer exist (may be stale):`,
    );
    for (const f of report.missingPaths) {
      parts.push(`- ${f.filename}: ${f.path} — "${f.preview}"`);
    }
  }
  if (report.duplicateSlugs.length > 0) {
    parts.push(`\nDuplicate slugs (${report.duplicateSlugs.length}) — same slug under different types:`);
    for (const f of report.duplicateSlugs) {
      parts.push(`- "${f.slug}": ${f.filenames.join(", ")}`);
    }
  }
  if (report.nameMismatches.length > 0) {
    parts.push(`\nName mismatches (${report.nameMismatches.length}) — frontmatter name ≠ filename:`);
    for (const f of report.nameMismatches) {
      parts.push(`- ${f.filename} has name "${f.frontmatterName}"`);
    }
  }

  parts.push(
    "\nReport-only. Fix with memory delete (pass the filename) or memory save (same type + slug overwrites in place).",
  );
  return parts.join("\n");
}
