import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { SkillFile } from "./types.js";
import {
  MAX_LOADED_INJECTION_CHARS,
  MAX_SKILL_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INDEX_CHARS,
  MAX_SKILL_LINES,
  SKILL_FILENAME,
  SKILL_SLUG_RE,
} from "./types.js";

const INDEX_HEAD =
  "## Project Skills\n\n" +
  "Skills available in this project. They are inactive until the user activates them " +
  "(via /skill load <name>, or /<name> to activate and run). " +
  "Active skills have their full instructions in the system prompt.";

/** 从正文首行派生一行描述：跳过 frontmatter 残留/围栏/空行，剥标记字符，取首句并封顶 */
function fallbackDescription(body: string): string {
  const first = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l !== "---" && !l.startsWith("```"));
  if (!first) return "(no description)";
  const stripped = first.replace(/^#+\s*/, "").replace(/^[-*>]\s*/, "").replace(/`+/g, "");
  const sentence = /[^。；;.!?！？]+[。；;.!?！？]?/.exec(stripped)?.[0] ?? stripped;
  const desc = sentence.trim();
  return desc ? desc.slice(0, MAX_SKILL_DESCRIPTION_CHARS) : "(no description)";
}

/**
 * 项目级 skill 管理器，存于 <cwd>/.kda/skills/<slug>/SKILL.md。
 * 唯一运行时状态是已激活 slug 集合；skill 清单每次调用重扫磁盘
 * （与 memory segment「每次渲染从磁盘刷新」同构，新增 skill 无需重启）。
 * system prompt 注入索引（未激活仅 name + description），激活后注入正文。
 */
export class SkillManager {
  private loaded = new Set<string>();

  constructor(private cwd: string) {}

  private get dir(): string {
    return resolve(this.cwd, ".kda", "skills");
  }

  /** 存储目录绝对路径 */
  path(): string {
    return this.dir;
  }

  /** 实时扫描全部 skill（按 slug 排序）；目录缺失或无合法 skill → [] */
  list(): SkillFile[] {
    try {
      const entries = readdirSync(this.dir, { withFileTypes: true });
      const skills: SkillFile[] = [];
      for (const e of entries) {
        if (!e.isDirectory() || !SKILL_SLUG_RE.test(e.name)) continue;
        const skill = this.readSkill(e.name);
        if (skill) skills.push(skill);
      }
      return skills.sort((a, b) => a.slug.localeCompare(b.slug));
    } catch {
      return [];
    }
  }

  /** 读取单个 skill：frontmatter 解析 + 缺省兜底 + 读取时截断；缺失/损坏返回 null */
  private readSkill(slug: string): SkillFile | null {
    const path = resolve(this.dir, slug);
    try {
      const raw = readFileSync(resolve(path, SKILL_FILENAME), "utf-8");
      const { fm, body } = parseFrontmatter(raw);
      const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
      const name = fm.name?.trim() || slug;
      const description = fm.description?.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS) || fallbackDescription(trimmed);
      return { slug, name, description, body: this.truncateBody(trimmed), path };
    } catch {
      return null; // SKILL.md 缺失或不可读 → 静默跳过
    }
  }

  /** 截断正文：先按行截、再按字符截（只读不写，无需 frontmatter 开销核算） */
  private truncateBody(body: string): string {
    let lines = body.split("\n");
    if (lines.length > MAX_SKILL_LINES) lines = lines.slice(0, MAX_SKILL_LINES);
    let b = lines.join("\n");
    if (b.length > MAX_SKILL_CHARS) b = b.slice(0, MAX_SKILL_CHARS);
    return b;
  }

  /** 按 slug 或无空格 name 解析（大小写不敏感）；找不到 → undefined */
  resolve(idOrName: string): SkillFile | undefined {
    const key = idOrName.trim().toLowerCase();
    if (!key) return undefined;
    return this.list().find(
      (s) =>
        s.slug.toLowerCase() === key ||
        (s.name !== s.slug && !/\s/.test(s.name) && s.name.toLowerCase() === key),
    );
  }

  /** 激活：正文注入 system prompt；无法解析返回 false */
  load(idOrName: string): boolean {
    const s = this.resolve(idOrName);
    if (!s) return false;
    this.loaded.add(s.slug);
    return true;
  }

  /** 取消激活；无法解析或本未激活返回 false */
  unload(idOrName: string): boolean {
    const s = this.resolve(idOrName);
    if (!s) return false;
    return this.loaded.delete(s.slug);
  }

  isLoaded(idOrName: string): boolean {
    const s = this.resolve(idOrName);
    return s ? this.loaded.has(s.slug) : false;
  }

  /** 已激活 slug 列表（与当前扫描求交：目录被删后自愈出集），保持激活顺序 */
  getLoadedSkills(): string[] {
    const slugs = new Set(this.list().map((s) => s.slug));
    return [...this.loaded].filter((slug) => slugs.has(slug));
  }

  /** 索引段（slug + description + 激活标记）；无 skill 返回空串（段落自动消失） */
  buildIndexInjection(): string {
    const all = this.list();
    if (all.length === 0) return "";

    const loadedSet = new Set(this.getLoadedSkills());
    const index = all.map((s) => {
      const marker = loadedSet.has(s.slug) ? " [active]" : "";
      return `- ${s.slug} — ${s.description}${marker}`;
    });
    const fits = (ls: string[]) =>
      INDEX_HEAD.length + 1 + ls.join("\n").length <= MAX_SKILL_INDEX_CHARS;

    let lines = index;
    let omitted = 0;
    if (!fits(lines)) {
      lines = [];
      for (const line of index) {
        if (!fits([...lines, line])) break;
        lines.push(line);
      }
      omitted = all.length - lines.length;
    }

    const parts = [INDEX_HEAD, "", ...lines];
    if (omitted > 0) parts.push(`... (${omitted} more skill${omitted === 1 ? "" : "s"} omitted)`);
    return parts.join("\n");
  }

  /** 已激活正文段（每个 skill 一个小节，激活顺序）；未激活返回空串 */
  buildLoadedInjection(): string {
    const bySlug = new Map(this.list().map((s) => [s.slug, s]));
    const loadedSlugs = this.getLoadedSkills();
    const blocks: string[] = [];
    let total = 0;
    let omitted = 0;
    for (const slug of loadedSlugs) {
      const s = bySlug.get(slug)!;
      const block = `## Active Skill: ${s.slug}\n${s.body}`;
      if (total + block.length > MAX_LOADED_INJECTION_CHARS) {
        omitted = loadedSlugs.length - blocks.length;
        break;
      }
      blocks.push(block);
      total += block.length;
    }
    if (blocks.length === 0) return "";
    const parts = [...blocks];
    if (omitted > 0) parts.push(`... (${omitted} more skill${omitted === 1 ? "" : "s"} omitted)`);
    return parts.join("\n\n");
  }

  /** 激活并返回转发给 LLM 的执行指令；无法解析返回 null */
  activateForExecution(idOrName: string, args: string): string | null {
    const s = this.resolve(idOrName);
    if (!s) return null;
    this.loaded.add(s.slug);
    const base = `Execute the skill "${s.slug}" now, following its instructions under "## Active Skill: ${s.slug}" in your system prompt.`;
    return args.trim() ? `${base} Arguments: ${args.trim()}` : base;
  }
}
