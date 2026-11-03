import { jsonSchema } from "ai";
import { MEMORY_TYPES, MEMORY_NAME_RE, MAX_DESCRIPTION_CHARS, MAX_FILE_CHARS } from "../memory/index.js";
import type { MemoryStore, MemoryType } from "../memory/index.js";
import type { Tool } from "./types.js";

/**
 * 创建 memory 工具。与 search_tools 同为系统级工具：经工厂创建、单独注册。
 * MemoryStore 由装配层外显构造并 init 后，经参数注入（不在工具内部创建）。
 */
export function createMemoryTool(memoryStore: MemoryStore): Tool {
  return {
    name: "memory",
    description:
      "Save, read, or delete long-term memories about this project, persisted in .kda/memory/ " +
      "and indexed in your system prompt in every future session here.\n\n" +
      "Record ONLY these four kinds of durable knowledge:\n" +
      "- user: user profile — role, background, habits, preferences\n" +
      "- feedback: corrections to your behavior — e.g. the user says \"don't do X\" or \"X is better than Y\"\n" +
      "- dynamic: project dynamics — ongoing work, decisions, dates. ALWAYS convert relative dates to absolute ones (\"next Monday\" → 2026-11-09)\n" +
      "- resource: pointers to external systems — URLs, dashboards, tickets, paths outside this repo\n\n" +
      "NEVER record: anything derivable from the code, anything derivable from git history, " +
      "or anything already documented in project docs (CLAUDE.md, README, etc.).\n\n" +
      "The system prompt shows only the memory index — call read (with the name shown in the index) " +
      "to get a memory's full content. Memories are clues, not facts: verify them against the " +
      "codebase before relying on them. To update, save again with the same type and slug.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "read", "delete"],
          description: "save = create or update a memory; read = get one memory's full content; delete = remove one",
        },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description: "Required for save: user | feedback | dynamic | resource",
        },
        slug: {
          type: "string",
          description:
            "Required for save: short kebab-case name WITHOUT the type prefix (the system prefixes it automatically). Keep it stable to update in place.",
        },
        name: {
          type: "string",
          description: "Required for read/delete: the full memory name as shown in the index (e.g. feedback-no-npm)",
        },
        description: {
          type: "string",
          description: "Required for save: one-line summary for the index, max 160 chars (if omitted, derived from the body's first sentence)",
        },
        body: {
          type: "string",
          description:
            "Required for save: markdown content, max 200 lines / 4000 chars per file (longer input is truncated)",
        },
      },
      required: ["action"],
    }),
    async execute(args, _ctx) {
      const action = args.action as string;

      if (action === "save") {
        // 兼容模型误把完整 id 传进 slug/name：store 幂等剥前缀，两种形式归一
        const rawName = ((args.name as string) ?? "").trim();
        const slug = ((args.slug as string) ?? rawName).trim();
        const body = (args.body as string) ?? "";
        // description 兜底链，保证一次调用成功：
        // ① 显式 description ② name 为标题形态（非 id）时作标题 ③ 从 body 首行/首句派生
        let description = ((args.description as string) ?? "").trim();
        if (!description && rawName && !MEMORY_NAME_RE.test(rawName)) {
          description = rawName.slice(0, MAX_DESCRIPTION_CHARS);
        }
        if (!description) {
          description = deriveDescription(body);
        }
        try {
          const m = memoryStore.upsert({
            type: args.type as MemoryType,
            slug,
            description,
            body,
          });
          return `Memory saved: ${m.id} (${m.type}) → .kda/memory/${m.id}.md (index updated)`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (action === "read" || action === "delete") {
        const name = ((args.name as string) ?? (args.slug as string) ?? "").trim();

        if (action === "read") {
          const m = memoryStore.read(name);
          if (!m) return notFound(memoryStore, name);
          return `name: ${m.id}\ntype: ${m.type}\ndescription: ${m.description}\nupdated: ${m.updated}\n\n${m.body}`;
        }

        if (!memoryStore.delete(name)) return notFound(memoryStore, name);
        return `Memory deleted: ${name} (index updated)`;
      }

      return `Error: unknown action "${action}" (use "save", "read" or "delete")`;
    },
    // read 需容纳整篇正文（文件限额 MAX_FILE_CHARS）+ name/type/description/updated 头部
    maxResultLength: MAX_FILE_CHARS + 1_000,
  };
}

function notFound(memoryStore: MemoryStore, name: string): string {
  const existing = memoryStore.loadAll().map((m) => m.id);
  return `Error: memory "${name}" not found` +
    (existing.length > 0 ? `. Existing memories: ${existing.join(", ")}` : " (no memories saved)");
}

/** 从正文首行/首句派生一行摘要（save 缺 description 时的最终兜底） */
function deriveDescription(body: string): string {
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const stripped = firstLine.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "");
  const sentence = /[^。；;.!?！？]+[。；;.!?！？]?/.exec(stripped)?.[0] ?? stripped;
  return sentence.trim().slice(0, MAX_DESCRIPTION_CHARS);
}
