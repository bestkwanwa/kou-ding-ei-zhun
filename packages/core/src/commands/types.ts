import type { SkillManager } from "../skills/index.js";
import type { PluginManager } from "../plugins/index.js";
import type { ChannelGateway } from "../channels/index.js";
import type { SecurityManager } from "../security/index.js";
import type { CronManager } from "../cron/index.js";

/** /model 命令的运行时切换句柄（agent 主循环构造注入） */
export interface ModelSwitcher {
  /** 展示用供应商名 */
  provider: string;
  get(): string;
  set(id: string): void;
}

export interface CommandContext {
  cwd: string;
  /** 技能管理器（/skill 命令与 /<skill-name> 快捷执行依赖；测试等场景可省略） */
  skills?: SkillManager;
  /** Plugin 管理器（/plugin 命令依赖；测试等场景可省略） */
  plugins?: PluginManager;
  /** Channel 网关（/channel 命令依赖；测试等场景可省略） */
  channels?: ChannelGateway;
  /** 模型切换句柄（/model 命令依赖；测试等场景可省略） */
  model?: ModelSwitcher;
  /** 安全管理器（/security 命令依赖；agent 主循环默认自建，测试等场景可省略） */
  security?: SecurityManager;
  /** Cron 调度器（/cron 命令依赖；由 CLI 层创建后传入，退出时 finally stop） */
  cron?: CronManager;
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
