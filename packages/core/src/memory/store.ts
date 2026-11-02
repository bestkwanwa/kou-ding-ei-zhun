import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { Frontmatter } from "./frontmatter.js";
import type { MemoryFile, MemoryInput } from "./types.js";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_CHARS,
  MAX_FILE_LINES,
  MAX_INDEX_CHARS,
  MAX_INJECTION_CHARS,
  MAX_MEMORY_FILES,
  MEMORY_NAME_RE,
  MEMORY_TYPES,
} from "./types.js";

const INDEX_FILENAME = "MEMORY.md";

/**
 * 项目级持久记忆，存于 <cwd>/.kda/memory/。
 * 每条记忆一个 frontmatter md 文件，外加代码生成的 MEMORY.md 索引。
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

  private filePath(name: string): string {
    return resolve(this.dir, `${name}.md`);
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

  /** 容错解析：frontmatter 缺失/非法时 name 取文件名、type 退化为 fact；超限 body 截回 */
  private parseFile(filename: string, raw: string): MemoryFile {
    const { fm, body } = parseFrontmatter(raw);
    // 去掉文件末尾换行，使 body 往返（save → load）不累积空白
    const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
    const name = (fm.name || filename.replace(/\.md$/, "")).slice(0, 50);
    const type = (MEMORY_TYPES as readonly string[]).includes(fm.type)
      ? (fm.type as MemoryFile["type"])
      : "fact";
    const description = fm.description ?? "";
    return {
      name,
      type,
      description,
      updated: fm.updated ?? "",
      body: this.truncateBody({ name, type, description, updated: fm.updated ?? "" }, trimmed),
    };
  }

  /** 校验并写入一条记忆（同名覆盖）。达文件数上限的新增抛错，超限 body 截断。 */
  upsert(input: MemoryInput): MemoryFile {
    if (!MEMORY_NAME_RE.test(input.name)) {
      throw new Error(
        `Invalid memory name "${input.name}": use kebab-case (lowercase letters, digits, hyphens), max 50 chars`,
      );
    }
    if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
      throw new Error(`Invalid memory type "${input.type}": must be one of ${MEMORY_TYPES.join(" | ")}`);
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
    const isNew = !existing.some((m) => m.name === input.name);
    if (isNew && existing.length >= MAX_MEMORY_FILES) {
      throw new Error(
        `Memory limit reached (${MAX_MEMORY_FILES} files). Delete one first. Existing: ${existing.map((m) => m.name).join(", ")}`,
      );
    }

    const updated = new Date().toISOString();
    const fm: Frontmatter = {
      name: input.name,
      type: input.type,
      description: input.description,
      updated,
    };
    const body = this.truncateBody(fm, input.body);

    this.ensureDir();
    writeFileSync(this.filePath(input.name), serializeFrontmatter(fm) + body + "\n", "utf-8");
    this.writeIndex();
    return { ...input, updated, body };
  }

  /** 删除一条记忆并更新索引；不存在（或 name 非法）返回 false */
  delete(name: string): boolean {
    if (!MEMORY_NAME_RE.test(name)) return false;
    const path = this.filePath(name);
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
      lines.push(`- [${m.name}](${m.name}.md) — ${m.description}`);
    }
    let content = lines.join("\n") + "\n";
    if (content.length > MAX_INDEX_CHARS) {
      content = content.slice(0, MAX_INDEX_CHARS) + "\n";
    }
    this.ensureDir();
    writeFileSync(resolve(this.dir, INDEX_FILENAME), content, "utf-8");
  }

  /** 注入 system prompt 的文本；无记忆时返回空串。超总限时整文件为单位丢弃尾部。 */
  buildInjectionText(): string {
    const all = this.loadAll();
    if (all.length === 0) return "";

    const head = [
      "## Project Memory",
      "",
      "Long-lived knowledge about this project, carried across sessions. Maintained with the memory tool.",
      "",
    ];
    const index = all.map((m) => `- [${m.name}](${m.name}.md) — ${m.description}`);
    const prefix = [...head, ...index].join("\n");

    const blocks: string[] = [];
    let used = prefix.length;
    for (const m of all) {
      const block = `\n\n### ${m.name}\n\n${m.description}\n\n${m.body}`;
      if (used + block.length > MAX_INJECTION_CHARS) break;
      blocks.push(block);
      used += block.length;
    }

    let text = prefix + blocks.join("");
    const omitted = all.length - blocks.length;
    if (omitted > 0) {
      text += `\n\n... (${omitted} more ${omitted === 1 ? "memory" : "memories"} omitted)`;
    }
    return text;
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
