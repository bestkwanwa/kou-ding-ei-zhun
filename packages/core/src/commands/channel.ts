import chalk from "chalk";
import type { ChannelGateway, ChannelInfo } from "../channels/index.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /channel <action>

Actions:
  list            List channels and their status (default)
  start [name]    Start a channel (default: web)
  stop <name>     Stop a running channel
  help            Show usage

The "web" channel serves a local chat page to talk to the running agent
from a browser (binds 127.0.0.1; port via KDA_CHANNEL_PORT env, default 8787).
Channel messages are handled by the same agent session, serially with the terminal.`;

function statusMarker(c: ChannelInfo): string {
  switch (c.status) {
    case "running":
      return chalk.green("[running]");
    case "starting":
      return chalk.yellow("[starting]");
    case "error":
      return chalk.red("[error]");
    default:
      return chalk.gray("[stopped]");
  }
}

function renderList(gateway: ChannelGateway): string {
  const all = gateway.list();
  if (all.length === 0) {
    return chalk.gray("No channels registered.");
  }
  const lines = all.map((c) => {
    let line = `  ${chalk.yellow(c.name)}  ${statusMarker(c)}`;
    if (c.detail) line += `  ${c.status === "error" ? chalk.red(c.detail) : chalk.cyan(c.detail)}`;
    line += chalk.gray(`  ${c.description}`);
    return line;
  });
  return `Channels (${all.length}):\n${lines.join("\n")}`;
}

export const channelCommand: Command = {
  name: "channel",
  description: "Manage channels (chat with the agent from outside)",
  usage: "/channel <list|start|stop|help>",
  execute(args, ctx) {
    if (!ctx.channels) return "Channels are not available.";
    const gateway = ctx.channels;
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";
    const name = parts[1] ?? "";

    switch (action) {
      case "list":
        return renderList(gateway);

      case "start": {
        const target = name || "web";
        const err = gateway.start(target);
        if (err) return err;
        // 乐观提示：实际监听结果异步落 status（失败会终端 warn，且 list 显示 [error]）
        const detail = gateway.list().find((c) => c.name === target)?.detail;
        return `Channel "${target}" starting → ${detail ?? "(see /channel list)"}`;
      }

      case "stop": {
        if (!name) return `Usage: /channel stop <name>`;
        const err = gateway.stop(name);
        if (err) return err;
        return `Channel "${name}" stopped.`;
      }

      case "help":
      default:
        return USAGE;
    }
  },
};
