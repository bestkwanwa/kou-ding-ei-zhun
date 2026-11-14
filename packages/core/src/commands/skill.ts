import chalk from "chalk";
import type { SkillManager } from "../skills/index.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /skill <action>

Actions:
  list              列出全部 skill（默认动作，标记已激活）
  load <name>       激活：正文注入 system prompt（不触发对话）
  unload <name>     取消激活
  path              显示存储目录

快捷执行：/<skill-name> [args] —— 激活并立即执行。
与内置命令同名的 skill 用 /skill load <name> 激活（快捷写法被内置命令占据）。`;

function notFound(skills: SkillManager, name: string): string {
  const existing = skills.list().map((s) => s.slug);
  return `Skill "${name}" not found.` +
    (existing.length > 0 ? ` Existing: ${existing.join(", ")}.` : " (no skills found)");
}

export const skillCommand: Command = {
  name: "skill",
  description: "Manage project skills (.kda/skills/)",
  usage: "/skill <list|load|unload|path>",
  execute(args, ctx) {
    if (!ctx.skills) return "Skills are not available.";
    const skills = ctx.skills;
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";
    const nameArg = parts.slice(1).join(" ");

    switch (action) {
      case "list": {
        const all = skills.list();
        if (all.length === 0) {
          return chalk.gray("No skills found. Create one at .kda/skills/<name>/SKILL.md.");
        }
        const lines = all.map((s) => {
          const marker = skills.isLoaded(s.slug) ? chalk.green("[loaded]") : chalk.gray("[available]");
          return `  ${chalk.yellow(s.slug)}  ${marker}  ${s.description}`;
        });
        return `Project skills (${all.length}):\n${lines.join("\n")}`;
      }

      case "load": {
        if (!nameArg) return `Usage: /skill load <name>`;
        if (!skills.load(nameArg)) return notFound(skills, nameArg);
        return `Skill "${nameArg}" loaded (instructions injected into the system prompt).`;
      }

      case "unload": {
        if (!nameArg) return `Usage: /skill unload <name>`;
        if (!skills.resolve(nameArg)) return notFound(skills, nameArg);
        if (!skills.unload(nameArg)) return `Skill "${nameArg}" is not loaded.`;
        return `Skill "${nameArg}" unloaded.`;
      }

      case "path":
        return skills.path();

      case "help":
      default:
        return USAGE;
    }
  },
};
