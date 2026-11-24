import chalk from "chalk";
import { DEFAULT_CHANNEL_ROLE, isRole } from "../security/index.js";
import type { Command, CommandContext } from "./types.js";

const USAGE = `Usage: /security <action>

Actions:
  status                Show current actor and channel roles (default)
  set <channel> <role>  Set a channel's role (owner only)
  help                  Show usage

Roles: owner (everything, terminal only), collaborator (read/write tools +
safe shell commands), guest (read-only tools only, no shell).
The terminal is always owner. Each channel has one role shared by ALL its
senders (default: guest), persisted to .kda/security.json — role is resolved
by channel name, never by sender name.`;

function renderStatus(ctx: CommandContext): string {
  const security = ctx.security!;
  const actor = security.currentActor;
  const configured = security.roles.listChannelRoles();
  // 注册渠道与已配置渠道取并集（未启动的渠道也可能有持久化角色）
  const names = [...new Set([...(ctx.channels?.list().map((c) => c.name) ?? []), ...Object.keys(configured)])].sort();
  const lines = names.map((name) => {
    const role = configured[name] ?? DEFAULT_CHANNEL_ROLE;
    const isDefault = configured[name] === undefined;
    return `  ${chalk.yellow(name)}  ${role}${isDefault ? chalk.gray(" (default)") : ""}`;
  });
  const channelPart = lines.length > 0 ? `\nChannels:\n${lines.join("\n")}` : "\nChannels: (none)";
  const sender = actor.sender ? `, sender: ${actor.sender}` : "";
  return `Current actor: ${chalk.bold(actor.role)} (source: ${actor.source}${sender})${channelPart}`;
}

export const securityCommand: Command = {
  name: "security",
  description: "Manage roles and security settings (owner/collaborator/guest)",
  usage: "/security <status|set|help>",
  execute(args, ctx) {
    if (!ctx.security) return "Security is not available.";
    const security = ctx.security;
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "status";

    switch (action) {
      case "status":
        return renderStatus(ctx);

      case "set": {
        const [, name, role] = parts;
        if (!name || !role || !isRole(role)) {
          return `Usage: /security set <channel> <owner|collaborator|guest>`;
        }
        // owner-only：terminal 恒为 owner；渠道默认 guest，无法自我提权
        if (security.currentActor.role !== "owner") {
          return `Error: [security] only the owner (terminal) can change security settings.`;
        }
        const result = security.roles.setChannelRole(name, role);
        if (result === "io-error") return `Error: [security] failed to write security state file.`;
        return `Role "${role}" set for channel "${name}".`;
      }

      case "help":
      default:
        return USAGE;
    }
  },
};
