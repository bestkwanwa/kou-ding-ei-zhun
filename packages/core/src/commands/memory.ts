import chalk from "chalk";
import { MemoryStore } from "../memory/index.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /memory <action>

Actions:
  list              列出所有记忆（默认动作）
  show <name>       查看单条记忆全文（name 为索引中的完整名字，如 feedback-no-npm）
  delete <name>     删除一条记忆（完整名字）
  clear             清空全部记忆
  path              显示存储目录

新增/更新记忆：直接让 agent「记住 xxx」，它会调用 memory 工具写入。`;

export const memoryCommand: Command = {
  name: "memory",
  description: "Manage long-term project memory (.kda/memory/)",
  usage: "/memory <list|show|delete|clear|path>",
  execute(args, ctx) {
    const store = new MemoryStore(ctx.cwd);
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";
    const nameArg = parts.slice(1).join(" ");

    switch (action) {
      case "list": {
        const all = store.loadAll();
        if (all.length === 0) {
          return chalk.gray("No memories saved. Tell the agent to remember something.");
        }
        const lines = all.map(
          (m) =>
            `  ${chalk.yellow(m.id)}  ${chalk.gray(`(${m.type})`)}  ${m.description}` +
            `\n      ${chalk.gray(m.updated)}`,
        );
        return `Project memory (${all.length}):\n${lines.join("\n")}`;
      }

      case "show": {
        if (!nameArg) return `Usage: /memory show <name>`;
        const all = store.loadAll();
        const m = all.find((x) => x.id === nameArg);
        if (!m) {
          return `Memory "${nameArg}" not found.` +
            (all.length > 0 ? ` Existing: ${all.map((x) => x.id).join(", ")}` : "");
        }
        return `---\nname: ${m.id}\ntype: ${m.type}\ndescription: ${m.description}\nupdated: ${m.updated}\n---\n\n${m.body}`;
      }

      case "delete": {
        if (!nameArg) return `Usage: /memory delete <name>`;
        if (!store.delete(nameArg)) {
          const all = store.loadAll();
          return `Memory "${nameArg}" not found.` +
            (all.length > 0 ? ` Existing: ${all.map((x) => x.id).join(", ")}` : "");
        }
        return `Deleted memory: ${nameArg}`;
      }

      case "clear": {
        const n = store.clear();
        return n > 0 ? `Cleared ${n} ${n === 1 ? "memory" : "memories"}.` : "No memories to clear.";
      }

      case "path":
        return store.path();

      case "help":
      default:
        return USAGE;
    }
  },
};
