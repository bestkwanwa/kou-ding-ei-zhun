// --- 第一层：角色权限 ---

/** 角色：owner（全部）/ collaborator（读写 + safe shell）/ guest（只读工具） */
export type Role = "owner" | "collaborator" | "guest";

/** 当前发言者：驱动所有工具执行检查（terminal 恒为 owner，channel 按渠道名解析角色） */
export interface Actor {
  role: Role;
  /** "terminal" 或渠道名（= InboundMessage.channel） */
  source: string;
  /** 渠道轮次的展示名；terminal 轮次省略 */
  sender?: string;
}

/** 终端输入来源标识 */
export const TERMINAL_SOURCE = "terminal";

/** terminal 恒为 owner——硬编码，不落盘 */
export const TERMINAL_ROLE: Role = "owner";

/** security.json 中未配置的渠道默认角色 */
export const DEFAULT_CHANNEL_ROLE: Role = "guest";

/** cron 定时任务输入来源标识（伪渠道名：角色经 channelRoles["cron"] 配置，可用 /security set cron <role> 调整） */
export const CRON_SOURCE = "cron";

/** cron 轮次默认角色：无人值守执行，较 guest 宽（safe shell 可用）、较 owner 严（risky 拒绝） */
export const DEFAULT_CRON_ROLE: Role = "collaborator";

/** 状态文件（<cwd>/.kda/security.json） */
export const SECURITY_STATE_FILENAME = "security.json";

export interface SecurityState {
  /** 渠道名 → 角色；缺省 = guest。角色由该渠道的所有发送者共享 */
  channelRoles: Record<string, Role>;
}

// --- 第二层：bash 命令风险 ---

export type RiskLevel = "safe" | "risky" | "dangerous";

export interface RiskClassification {
  level: RiskLevel;
  /** 人类可读解释（规则 id / LLM 理由 / 兜底说明），进日志与 warn 消息 */
  reason: string;
  /** 判定来源——供日志与 warn 消息 */
  source: "rule" | "llm" | "default";
}

/** v1 中唯一走风险分类的工具 */
export const SHELL_TOOL_NAME = "run_command";

// --- 执行结果（三层共用） ---

export type SecurityAction = "allow" | "warn" | "deny";

export interface SecurityDecision {
  action: SecurityAction;
  /** deny → 进 "Error: [security] <reason>" 返回给 LLM；warn → 打印警告行；allow → 忽略 */
  reason: string;
}

// --- 第三层：hook ---

export interface HookInput {
  toolName: string;
  args: Record<string, unknown>;
  actor: Actor;
}

export interface BeforeHookResult {
  action: "allow" | "deny";
  /** 改写后的 args（仅 allow 时生效；省略 = 保留原值） */
  args?: Record<string, unknown>;
  /** 拒绝原因（仅 deny 时生效） */
  reason?: string;
}

export interface Hook {
  name: string;
  beforeExecute?(input: HookInput): BeforeHookResult | Promise<BeforeHookResult>;
  afterExecute?(input: HookInput, result: string): string | Promise<string>;
}

/** Role 运行时校验（/security 参数与 security.json 解析共用） */
export function isRole(v: unknown): v is Role {
  return v === "owner" || v === "collaborator" || v === "guest";
}
