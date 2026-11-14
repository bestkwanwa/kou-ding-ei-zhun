import chalk from "chalk";
import { MemoryStore, lintMemory } from "../memory/index.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /memory <action>

Actions:
  list              列出所有记忆（默认动作）
  show <name>       查看单条记忆全文（name 为索引中的完整名字，如 feedback-no-npm）
  delete <name>     删除一条记忆（完整名字）
  clear             清空全部记忆
  lint              体检：过期（保质期）/ 失效路径 / 重名检查（仅报告，不自动修复）
  path              显示存储目录

新增/更新记忆：直接让 agent「记住 xxx」，它会调用 memory 工具写入。`;

export const memoryCommand: Command = {
  name: "memory",
  description: "Manage long-term project memory (.kda/memory/)",
  usage: "/memory <list|show|delete|clear|lint|path>",
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
        // 与工具 read 同路（记 lastRead，且接受 xxx.md 形式的名字）
        const m = store.read(nameArg);
        if (!m) {
          const all = store.loadAll();
          return `Memory "${nameArg}" not found.` +
            (all.length > 0 ? ` Existing: ${all.map((x) => x.id).join(", ")}` : "");
        }
        return `---\nname: ${m.id}\ntype: ${m.type}\ndescription: ${m.description}\nupdated: ${m.updated}\nlastRead: ${m.lastRead ?? "(never)"}\n---\n\n${m.body}`;
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

      case "lint": {
        const report = lintMemory(ctx.cwd);
        if (report.total === 0) {
          return chalk.gray("No memories saved. Tell the agent to remember something.");
        }
        const issues =
          report.stale.length + report.missingPaths.length + report.duplicateSlugs.length + report.nameMismatches.length;
        if (issues === 0) {
          return chalk.green(`Memory lint (${report.total} memories): no issues found.`);
        }
        const lines: string[] = [
          chalk.bold(`Memory lint (${report.total} memories): ${issues} issue${issues === 1 ? "" : "s"} found.`),
        ];
        if (report.stale.length > 0) {
          lines.push(chalk.bold(`Stale (${report.stale.length})`) + chalk.gray(" — not read/written within the TTL for the type:"));
          for (const f of report.stale) {
            const since = f.usedField === "none"
              ? "timestamps missing/unparseable"
              : `${f.daysSince}d since ${f.usedField} ${chalk.gray(f.usedAt)}`;
            lines.push(`  ${chalk.yellow(f.filename)}  ${since}  ${chalk.gray(`(TTL ${f.ttlDays}d)`)}`);
          }
        }
        if (report.missingPaths.length > 0) {
          lines.push(chalk.bold(`Broken paths (${report.missingPaths.length})`) + chalk.gray(" — referenced paths no longer exist:"));
          for (const f of report.missingPaths) {
            lines.push(`  ${chalk.yellow(f.filename)}\n      ${f.path}`);
          }
        }
        if (report.duplicateSlugs.length > 0) {
          lines.push(chalk.bold(`Duplicate slugs (${report.duplicateSlugs.length})`) + chalk.gray(" — same slug under different types:"));
          for (const f of report.duplicateSlugs) {
            lines.push(`  "${f.slug}" → ${f.filenames.map((x) => chalk.yellow(x)).join(", ")}`);
          }
        }
        if (report.nameMismatches.length > 0) {
          lines.push(chalk.bold(`Name mismatches (${report.nameMismatches.length})`) + chalk.gray(" — frontmatter name ≠ filename:"));
          for (const f of report.nameMismatches) {
            lines.push(`  ${chalk.yellow(f.filename)} → ${chalk.gray(`name "${f.frontmatterName}"`)}`);
          }
        }
        lines.push(chalk.gray("Report-only: ask the agent to clean these up, or use /memory delete <name>."));
        return lines.join("\n");
      }

      case "path":
        return store.path();

      case "help":
      default:
        return USAGE;
    }
  },
};
