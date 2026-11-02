export { CommandDispatcher } from "./dispatcher.js";
export type { Command, CommandContext } from "./types.js";
export { memoryCommand } from "./memory.js";

import { CommandDispatcher } from "./dispatcher.js";
import { memoryCommand } from "./memory.js";
import type { Command } from "./types.js";
import type { CommandContext } from "./types.js";

/** 内置命令清单（banner 指南与 dispatcher 共用同一来源） */
export const DEFAULT_COMMANDS: Command[] = [memoryCommand];

/** 创建包含内置命令的 dispatcher */
export function createDefaultCommandDispatcher(ctx: CommandContext): CommandDispatcher {
  const dispatcher = new CommandDispatcher(ctx);
  for (const cmd of DEFAULT_COMMANDS) {
    dispatcher.register(cmd);
  }
  return dispatcher;
}
