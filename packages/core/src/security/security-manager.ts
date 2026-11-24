import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool } from "../tools/types.js";
import { BashRiskMonitor, type BashRiskOptions } from "./bash-risk.js";
import { HookManager, createBuiltinHooks } from "./hook-manager.js";
import { DeniedIntentGuard } from "./intent-guard.js";
import { evaluatePolicy } from "./policy.js";
import { RoleManager } from "./role-manager.js";
import { SHELL_TOOL_NAME, type Actor, type SecurityDecision } from "./types.js";

export interface SecurityOptions {
  cwd: string;
  /** LLM 兜底的模型来源（跟随 /model 切换由调用方闭包实现）；缺省 = 规则-only，未命中默认 risky */
  getModel?: () => LanguageModelV3 | null;
  /** 透传给 BashRiskMonitor 的其余选项 */
  bashRisk?: Omit<BashRiskOptions, "getModel">;
}

/**
 * 安全门面：第一层（角色）+ 第二层（bash 风险）判定入口，持有第三层 hook 管理器。
 * check() 永不抛错——内部任何异常都收敛为 deny（fail-closed）。
 * hook 的执行不在此处（agent 主循环的 executeTool 咽喉点直接调 hooks.runBefore/runAfter，
 * 便于改写 args 与结果串）。
 */
export class SecurityManager {
  readonly roles: RoleManager;
  readonly hooks: HookManager;
  readonly bashRisk: BashRiskMonitor;

  private readonly intentGuard: DeniedIntentGuard;

  constructor(options: SecurityOptions) {
    this.roles = new RoleManager(options.cwd);
    this.hooks = new HookManager(createBuiltinHooks(options.cwd));
    this.bashRisk = new BashRiskMonitor({ getModel: options.getModel, ...options.bashRisk });
    this.intentGuard = new DeniedIntentGuard(options.cwd);
  }

  get currentActor(): Actor {
    return this.roles.current;
  }

  /** 用户新输入事件时调用：清空本轮意图记忆（用户再次触发 = 重新授权） */
  resetDeniedIntents(): void {
    this.intentGuard.reset();
  }

  /** 角色 × 工具 × 风险 判定（LLM 兜底仅对非 guest 的 run_command 触发） */
  async check(tool: Tool, args: Record<string, unknown>): Promise<SecurityDecision> {
    try {
      const actor = this.roles.current;
      let classification;
      if (tool.name === SHELL_TOOL_NAME && actor.role !== "guest") {
        // guest 的 run_command 直接拒（policy），不浪费一次分类
        const command = String(args.command ?? "");
        classification = await this.bashRisk.classify(command);
        // dangerous 被拒 → 记录目标；同轮次内对同一目标的低危变体一律 deny（防换写法绕过）
        if (classification.level === "dangerous") {
          this.intentGuard.record(command);
        } else if (this.intentGuard.isDenied(command)) {
          return {
            action: "deny",
            reason:
              "a dangerous operation on this target was denied earlier this turn — do NOT retry with a different command; ask the user to confirm or trigger it again",
          };
        }
      }
      const decision = evaluatePolicy({
        role: actor.role,
        toolName: tool.name,
        readOnly: tool.readOnly ?? false,
        risk: classification?.level,
      });
      // warn 的 reason 拼入风险解释（owner 看到的警告行有具体内容）
      if (decision.action === "warn" && classification) {
        return { ...decision, reason: `${decision.reason}: ${classification.reason}` };
      }
      return decision;
    } catch {
      return { action: "deny", reason: "security check failed (fail-closed)" };
    }
  }
}

export function createSecurityManager(options: SecurityOptions): SecurityManager {
  return new SecurityManager(options);
}
