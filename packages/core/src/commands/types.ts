import type { SkillManager } from "../skills/index.js";

export interface CommandContext {
  cwd: string;
  /** 技能管理器（/skill 命令与 /<skill-name> 快捷执行依赖；测试等场景可省略） */
  skills?: SkillManager;
}

export interface Command {
  /** 命令名，不含 "/"，如 "memory" */
  name: string;
  /** 一句话说明，用于未知命令提示与将来的 /help */
  description: string;
  /** 用法示例，如 "/memory <action>" */
  usage: string;
  /** 返回要打印的输出（"" = 静默成功）；同步实现 */
  execute(args: string, ctx: CommandContext): string;
}
