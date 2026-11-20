import type { ToolContext } from "../tools/types.js";

/** 目录名白名单，兼作路径穿越防护（同 SKILL_SLUG_RE 形态） */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 工具原始名白名单（保证加前缀后的名字对 AI SDK 合法） */
export const PLUGIN_TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** 入口文件候选，按序取首个存在者；.ts 仅在 ERR_UNKNOWN_FILE_EXTENSION 时回退下一候选 */
export const PLUGIN_ENTRY_CANDIDATES = ["index.ts", "index.mjs", "index.js"] as const;

/** 状态文件（<cwd>/.kda/plugins.json），记录 {"disabled": [...]} */
export const PLUGIN_STATE_FILENAME = "plugins.json";

/** 单个 plugin 的工具数上限，超出跳过并警告 */
export const MAX_TOOLS_PER_PLUGIN = 50;

/**
 * plugin 注册的工具描述。parameters 是原始 JSON Schema 对象：
 * plugin 目录下无法解析宿主依赖（ai/@kda/core），由 PluginManager 负责用 jsonSchema() 包装。
 */
export interface PluginToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;

  /** 是否只读（无副作用），默认 false */
  readOnly?: boolean;
  /** 是否可安全并行执行，默认 false */
  parallelizable?: boolean;
  /** 工具结果最大长度（字符数），默认走全局 10000 */
  maxResultLength?: number;
  /** 是否延迟加载（经 search_tools 发现后才对 LLM 可见） */
  lazy?: boolean;
  /** 搜索提示词，lazy=true 时建议提供 */
  hint?: string;
  /** 工具结果是否可被上下文管理清理 */
  cleanable?: boolean;
}

/** plugin 在 setup 阶段获得的全部能力：注册工具、获取配置、打日志 */
export interface PluginContext {
  /** 暂存工具，setup 成功后统一加前缀注册；setup 完成后再调用为 no-op */
  registerTool(tool: PluginToolSpec): void;
  /** 返回加载时解析的 PLUGIN_<NAME>__* 环境变量快照 */
  getConfig(): Record<string, string>;
  /** 以 [plugin:<name>] 标签写入 .kda/logs/debug.log（失败静默丢弃） */
  log(...args: unknown[]): void;
}

/** plugin 模块默认导出 definePlugin() 的返回值 */
export interface PluginDefinition {
  /** 必须等于目录名，否则加载失败 */
  name: string;
  version: string;
  description: string;
  setup(ctx: PluginContext): void | Promise<void>;
  /** 退出清理钩子，宿主退出时调用（错误被隔离） */
  dispose?(): void | Promise<void>;
}

export type PluginStatus = "enabled" | "disabled" | "error";

/** /plugin list 展示的单条信息（disabled/未加载的 plugin 无版本信息） */
export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  status: PluginStatus;
  /** 实际注册成功的前缀工具名 */
  tools: string[];
  error?: string;
}
