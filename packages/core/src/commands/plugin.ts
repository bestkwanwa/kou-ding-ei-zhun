import chalk from "chalk";
import type { PluginManager } from "../plugins/index.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /plugin <action>

Actions:
  list              列出全部 plugin 及状态（默认动作）
  enable <name>     启用（下次启动生效）
  disable <name>    禁用（下次启动不再加载）
  help              显示用法

Plugin 位于 .kda/plugins/<name>/，入口文件按序查找：
  index.mjs（推荐）、index.js（CJS 亦可）、index.ts（需 Node >= 22.18 或 tsx）。
配置通过环境变量注入：PLUGIN_<NAME>__<KEY>=value
  （<NAME> 为 plugin 名大写、"-"→"_"，如 PLUGIN_MY_TOOL__API_KEY）。`;

function notFound(plugins: PluginManager, name: string): string {
  const existing = plugins.list().map((p) => p.name);
  return `Plugin "${name}" not found.` +
    (existing.length > 0 ? ` Existing: ${existing.join(", ")}.` : " (no plugins found)");
}

/** 错误信息压成单行并截断，避免 list 输出被多行堆栈撑爆 */
function oneLine(msg: string, max = 160): string {
  const flat = msg.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export const pluginCommand: Command = {
  name: "plugin",
  description: "Manage plugins (.kda/plugins/)",
  usage: "/plugin <list|enable|disable|help>",
  execute(args, ctx) {
    if (!ctx.plugins) return "Plugins are not available.";
    const plugins = ctx.plugins;
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";
    const nameArg = parts.slice(1).join(" ");

    switch (action) {
      case "list": {
        const all = plugins.list();
        if (all.length === 0) {
          return chalk.gray("No plugins found. Create one at .kda/plugins/<name>/index.mjs.");
        }
        const lines = all.map((p) => {
          const marker = p.status === "enabled"
            ? chalk.green("[enabled]")
            : p.status === "disabled"
              ? chalk.gray("[disabled]")
              : chalk.red("[error]");
          let line = `  ${chalk.yellow(p.name)}  ${marker}`;
          // version 仅在实际加载后可知（disabled/未加载的 plugin 不 import）
          if (p.status === "enabled" && p.version) {
            line += `  v${p.version}  ${p.description}`;
            if (p.tools.length > 0) line += chalk.gray(`  (tools: ${p.tools.join(", ")})`);
          } else if (p.status === "error" && p.error) {
            line += `  failed to load: ${oneLine(p.error)}`;
          }
          return line;
        });
        return `Plugins (${all.length}):\n${lines.join("\n")}`;
      }

      case "enable": {
        if (!nameArg) return `Usage: /plugin enable <name>`;
        const result = plugins.enable(nameArg);
        if (result === "not-found") return notFound(plugins, nameArg);
        if (result === "io-error") return "Error: could not update .kda/plugins.json.";
        return `Plugin "${nameArg}" enabled (takes effect on next start).`;
      }

      case "disable": {
        if (!nameArg) return `Usage: /plugin disable <name>`;
        const result = plugins.disable(nameArg);
        if (result === "not-found") return notFound(plugins, nameArg);
        if (result === "io-error") return "Error: could not update .kda/plugins.json.";
        return `Plugin "${nameArg}" disabled (takes effect on next start).`;
      }

      case "help":
      default:
        return USAGE;
    }
  },
};
