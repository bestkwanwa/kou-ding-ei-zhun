export {
  DEFAULT_CHANNEL_ROLE,
  SECURITY_STATE_FILENAME,
  SHELL_TOOL_NAME,
  TERMINAL_ROLE,
  TERMINAL_SOURCE,
  isRole,
} from "./types.js";
export type {
  Actor,
  BeforeHookResult,
  Hook,
  HookInput,
  RiskClassification,
  RiskLevel,
  Role,
  SecurityAction,
  SecurityDecision,
  SecurityState,
} from "./types.js";
export { evaluatePolicy, type PolicyInput } from "./policy.js";
export { RoleManager } from "./role-manager.js";
export { DeniedIntentGuard, extractTargets } from "./intent-guard.js";
export { BashRiskMonitor, type BashRiskOptions, type RiskRule } from "./bash-risk.js";
export { HookManager, createBuiltinHooks, type BeforeHookOutcome } from "./hook-manager.js";
export { SecurityManager, createSecurityManager, type SecurityOptions } from "./security-manager.js";
