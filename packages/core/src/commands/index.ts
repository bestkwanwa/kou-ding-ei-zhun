export { CommandDispatcher } from "./dispatcher.js";
export type { DispatchResult } from "./dispatcher.js";
export type { Command, CommandContext, ModelSwitcher } from "./types.js";
export { memoryCommand } from "./memory.js";
export { skillCommand } from "./skill.js";
export { pluginCommand } from "./plugin.js";
export { channelCommand } from "./channel.js";
export { modelCommand } from "./model.js";

import { CommandDispatcher } from "./dispatcher.js";
import { memoryCommand } from "./memory.js";
import { skillCommand } from "./skill.js";
import { pluginCommand } from "./plugin.js";
import { channelCommand } from "./channel.js";
import { modelCommand } from "./model.js";
import type { Command } from "./types.js";
import type { CommandContext } from "./types.js";

/** 内置命令清单（banner 指南与 dispatcher 共用同一来源） */
export const DEFAULT_COMMANDS: Command[] = [memoryCommand, skillCommand, pluginCommand, channelCommand, modelCommand];

/** 创建包含内置命令的 dispatcher */
export function createDefaultCommandDispatcher(ctx: CommandContext): CommandDispatcher {
  const dispatcher = new CommandDispatcher(ctx);
  for (const cmd of DEFAULT_COMMANDS) {
    dispatcher.register(cmd);
  }
  return dispatcher;
}
