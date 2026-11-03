import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { Frontmatter } from "./frontmatter.js";
import type { MemoryFile, MemoryInput, MemoryType } from "./types.js";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_CHARS,
  MAX_FILE_LINES,
  MAX_INDEX_CHARS,
  MAX_INJECTION_CHARS,
  MAX_MEMORY_FILES,
  MAX_NAME_CHARS,
  MEMORY_NAME_RE,
  MEMORY_TYPES,
} from "./types.js";

const INDEX_FILENAME = "MEMORY.md";

const INJECTION_HEAD =
  "## Project Memory\n\n" +
  "Long-lived knowledge about this project, carried across sessions. " +
  "Only the index is loaded — use the memory tool's read action to read a specific memory's full content.";
const INJECTION_TAIL =
  "Memories are clues, not facts — verify their accuracy before relying on them.";

/** 剥掉 slug 已带的合法类型前缀（幂等），模型传 slug 或完整 id 都归一到同一记忆 */
function stripTypePrefix(slug: string): string {
  for (const t of MEMORY_TYPES) {
    if (slug.startsWith(`${t}-`)) return slug.slice(t.length + 1);
  }
  return slug;
}

/**
 * 项目级持久记忆，存于 <cwd>/.kda/memory/。
 * 每条记忆一个 frontmatter md 文件（文件名 = <type>-<slug>.md，类型自动前缀），
 * 外加代码生成的 MEMORY.md 索引。system prompt 只注入索引，正文经 read 取用。
 */
export class MemoryStore {
  constructor(private cwd: string) {}

  private get dir(): string {
    return resolve(this.cwd, ".kda", "memory");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** 显式初始化：创建存储目录（幂等）。写入前应由装配层调用一次。 */
  init(): void {
    this.ensureDir();
  }

  private filePath(id: string): string {
    return resolve(this.dir, `${id}.md`);
  }

  /** 存储目录绝对路径 */
  path(): string {
    return this.dir;
  }

  loadAll(): MemoryFile[] {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME)
        .sort();
      const memories: MemoryFile[] = [];
      for (const f of files) {
        try {
          const raw = readFileSync(resolve(this.dir, f), "utf-8");
          memories.push(this.parseFile(f, raw));
        } catch {
          // 单个文件损坏则跳过
        }
      }
      return memories;
    } catch {
      return [];
    }
  }

  /** 按完整 id 读取单条记忆；不存在（或 id 非法）返回 null */
  read(id: string): MemoryFile | null {
    if (!MEMORY_NAME_RE.test(id)) return null;
    try {
      const raw = readFileSync(this.filePath(id), "utf-8");
      return this.parseFile(`${id}.md`, raw);
    } catch {
      return null;
    }
  }

  /** 容错解析：type 取 frontmatter，非法时按文件名前缀识别，仍不识别则降级 dynamic */
  private parseFile(filename: string, raw: string): MemoryFile {
    const { fm, body } = parseFrontmatter(raw);
    // 去掉文件末尾换行，使 body 往返（save → load）不累积空白
    const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
    const id = (fm.name || filename.replace(/\.md$/, "")).slice(0, MAX_NAME_CHARS);
    const type = this.resolveType(fm.type, id);
    const description = fm.description ?? "";
    return {
      id,
      type,
      description,
      updated: fm.updated ?? "",
      body: this.truncateBody({ name: id, type, description, updated: fm.updated ?? "" }, trimmed),
    };
  }

  private resolveType(raw: string | undefined, id: string): MemoryType {
    if (raw && (MEMORY_TYPES as readonly string[]).includes(raw)) return raw as MemoryType;
    for (const t of MEMORY_TYPES) {
      if (id.startsWith(`${t}-`)) return t;
    }
    return "dynamic";
  }

  /** 校验并写入一条记忆（同名覆盖）。达文件数上限的新增抛错，超限 body 截断。 */
  upsert(input: MemoryInput): MemoryFile {
    if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
      throw new Error(`Invalid memory type "${input.type}": must be one of ${MEMORY_TYPES.join(" | ")}`);
    }
    const slug = stripTypePrefix(input.slug.trim());
    if (!slug) {
      throw new Error("Memory slug is required (short kebab-case name, without the type prefix)");
    }
    const id = `${input.type}-${slug}`;
    if (!MEMORY_NAME_RE.test(id)) {
      throw new Error(
        `Invalid memory name "${slug}" (stored as "${id}"): use kebab-case (lowercase letters, digits, hyphens), max ${MAX_NAME_CHARS} chars including the type prefix`,
      );
    }
    if (!input.description.trim()) {
      throw new Error("Memory description is required");
    }
    if (input.description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`Memory description too long (${input.description.length} > ${MAX_DESCRIPTION_CHARS} chars)`);
    }
    if (!input.body.trim()) {
      throw new Error("Memory body is required");
    }

    const existing = this.loadAll();
    const isNew = !existing.some((m) => m.id === id);
    if (isNew && existing.length >= MAX_MEMORY_FILES) {
      throw new Error(
        `Memory limit reached (${MAX_MEMORY_FILES} files). Delete one first. Existing: ${existing.map((m) => m.id).join(", ")}`,
      );
    }

    const updated = new Date().toISOString();
    const fm: Frontmatter = { name: id, type: input.type, description: input.description, updated };
    const body = this.truncateBody(fm, input.body);

    this.ensureDir();
    writeFileSync(this.filePath(id), serializeFrontmatter(fm) + body + "\n", "utf-8");
    this.writeIndex();
    return { id, type: input.type, description: input.description, updated, body };
  }

  /** 删除一条记忆并更新索引；不存在（或 id 非法）返回 false */
  delete(id: string): boolean {
    if (!MEMORY_NAME_RE.test(id)) return false;
    const path = this.filePath(id);
    if (!existsSync(path)) return false;
    rmSync(path);
    this.writeIndex();
    return true;
  }

  /** 清空全部记忆文件（保留目录与索引），返回删除数 */
  clear(): number {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME);
      for (const f of files) {
        rmSync(resolve(this.dir, f));
      }
      this.writeIndex();
      return files.length;
    } catch {
      return 0;
    }
  }

  /** 从当前记忆全量重生成 MEMORY.md 索引 */
  writeIndex(): void {
    const all = this.loadAll();
    const lines = ["# Project Memory", ""];
    for (const m of all) {
      lines.push(`- [${m.id}](${m.id}.md) — ${m.description}`);
    }
    let content = lines.join("\n") + "\n";
    if (content.length > MAX_INDEX_CHARS) {
      content = content.slice(0, MAX_INDEX_CHARS) + "\n";
    }
    this.ensureDir();
    writeFileSync(resolve(this.dir, INDEX_FILENAME), content, "utf-8");
  }

  /** 注入 system prompt 的文本（仅索引 + 取用提示）；无记忆时返回空串 */
  buildInjectionText(): string {
    const all = this.loadAll();
    if (all.length === 0) return "";

    const index = all.map((m) => `- [${m.id}](${m.id}.md) — ${m.description}`);
    // 头部 + 索引 + 空行 + 尾部提示
    const fits = (ls: string[]) =>
      INJECTION_HEAD.length + 1 + ls.join("\n").length + 2 + INJECTION_TAIL.length <= MAX_INJECTION_CHARS;

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

    const parts = [INJECTION_HEAD, "", ...lines];
    if (omitted > 0) parts.push(`... (${omitted} more ${omitted === 1 ? "memory" : "memories"} omitted)`, "");
    parts.push("", INJECTION_TAIL);
    return parts.join("\n");
  }

  /** 截断 body 使落盘文件（frontmatter 含内）满足行数/字符限额：先按行截、再按字符截 */
  private truncateBody(fm: Frontmatter, body: string): string {
    const overhead = serializeFrontmatter(fm);
    const overheadLines = overhead.split("\n").filter(Boolean).length;

    let lines = body.split("\n");
    if (overheadLines + lines.length > MAX_FILE_LINES) {
      lines = lines.slice(0, Math.max(0, MAX_FILE_LINES - overheadLines));
    }
    let b = lines.join("\n");

    const charBudget = MAX_FILE_CHARS - overhead.length;
    if (b.length > charBudget) {
      b = b.slice(0, Math.max(0, charBudget));
    }
    return b;
  }
}
