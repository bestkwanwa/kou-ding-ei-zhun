import { jsonSchema } from "ai";
import { MEMORY_TYPES } from "../memory/index.js";
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
      "Save or delete long-term memories about this project, persisted in .kda/memory/ and injected into your system prompt in every future session here. " +
      "Save when you learn durable knowledge: project (structure, build/test commands, conventions, architecture), " +
      "fact (stable facts discovered in the codebase), preference (how the user wants things done), " +
      "decision (design decisions and rationale). ALWAYS call this when the user asks you to remember something. " +
      "Do NOT save transient task state, anything obvious from the repo itself, secrets, or personal data. " +
      "To update a memory, save again with the same name — it overwrites in place.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "delete"],
          description: "save = create or update a memory; delete = remove one",
        },
        name: {
          type: "string",
          description:
            "Unique kebab-case id (lowercase letters, digits, hyphens, max 50 chars). Keep it stable when updating an existing memory.",
        },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description: "Required for save: project | fact | preference | decision",
        },
        description: {
          type: "string",
          description: "Required for save: one-line summary, max 160 chars",
        },
        body: {
          type: "string",
          description:
            "Required for save: markdown content, max 200 lines / 4000 chars per file (longer input is truncated)",
        },
      },
      required: ["action", "name"],
    }),
    async execute(args, _ctx) {
      const action = args.action as string;
      const name = ((args.name as string) ?? "").trim();
      const store = memoryStore;

      if (action === "save") {
        try {
          const m = store.upsert({
            name,
            type: args.type as MemoryType,
            description: (args.description as string) ?? "",
            body: (args.body as string) ?? "",
          });
          return `Memory saved: ${m.name} (${m.type}) → .kda/memory/${m.name}.md (index updated)`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (action === "delete") {
        if (!store.delete(name)) {
          const existing = store.loadAll().map((m) => m.name);
          return `Error: memory "${name}" not found` +
            (existing.length > 0 ? `. Existing memories: ${existing.join(", ")}` : " (no memories saved)");
        }
        return `Memory deleted: ${name} (index updated)`;
      }

      return `Error: unknown action "${action}" (use "save" or "delete")`;
    },
    maxResultLength: 1_000,
  };
}
