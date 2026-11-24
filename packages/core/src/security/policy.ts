import { SHELL_TOOL_NAME, type RiskLevel, type Role, type SecurityDecision } from "./types.js";

export interface PolicyInput {
  role: Role;
  toolName: string;
  /** tool.readOnly ?? false */
  readOnly: boolean;
  /** 命令风险等级；非 run_command（或 guest，其 run_command 直接拒）时省略 */
  risk?: RiskLevel;
}

/**
 * 角色 × 工具 × 风险 判定矩阵（同步纯函数）：
 *
 * |             | readOnly 工具 | 写工具等 | safe shell | risky shell | dangerous shell |
 * |-------------|--------------|---------|-----------|------------|-----------------|
 * | guest       | allow        | deny    | deny（不分类） | deny   | deny            |
 * | collaborator| allow        | allow   | allow     | deny       | deny            |
 * | owner       | allow        | allow   | allow     | warn       | deny            |
 */
export function evaluatePolicy(input: PolicyInput): SecurityDecision {
  // dangerous 最先判：任何角色都不放行。原因里写明指令——让模型第一次被拒就停手，
  // 而不是自行尝试低危变体（变体另有意图拦截兜底，见 intent-guard）
  if (input.risk === "dangerous") {
    return {
      action: "deny",
      reason:
        "dangerous shell command denied for all roles — do NOT retry this or a variant command on the same target; report the denial to the user and let them run it manually or explicitly re-request it",
    };
  }

  if (input.toolName === SHELL_TOOL_NAME) {
    switch (input.role) {
      case "guest":
        return { action: "deny", reason: "guest role cannot execute shell commands" };
      case "collaborator":
        if (input.risk === "safe") return { action: "allow", reason: "" };
        return { action: "deny", reason: "collaborator role allows only safe shell commands" };
      case "owner":
        if (input.risk === "risky") return { action: "warn", reason: "risky shell command" };
        return { action: "allow", reason: "" };
    }
  }

  // 非 shell 工具：guest 仅 readOnly，其余放行
  if (input.role === "guest" && !input.readOnly) {
    return { action: "deny", reason: `guest role can only use read-only tools (${input.toolName} is not read-only)` };
  }
  return { action: "allow", reason: "" };
}
