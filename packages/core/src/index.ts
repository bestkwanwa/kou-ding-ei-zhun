export { runAgent, AgentError } from "./agent/index.js";
export type { AgentOptions } from "./agent/index.js";

export { loadConfig } from "./config/index.js";
export type { AppConfig, ConfigOverrides, ProviderName } from "./config/index.js";

export { createModelFactory } from "./llm/index.js";
export type { ModelFactory, LanguageModelV3 } from "./llm/index.js";

export { ToolRegistry, createDefaultRegistry } from "./tools/index.js";
export type { Tool, ToolContext } from "./tools/index.js";

export { SessionStore } from "./session/index.js";
export type { SessionData, SessionMetadata } from "./session/index.js";

export { MemoryStore } from "./memory/index.js";
export type { MemoryFile, MemoryInput, MemoryType } from "./memory/index.js";

export { SkillManager } from "./skills/index.js";
export type { SkillFile } from "./skills/index.js";

export { PluginManager, parsePluginEnv } from "./plugins/index.js";
export type { PluginContext, PluginDefinition, PluginInfo, PluginStatus, PluginToolSpec } from "./plugins/index.js";

export { ChannelGateway, createDefaultChannelGateway, createWebChannel, DEFAULT_WEB_CHANNEL_PORT } from "./channels/index.js";
export type { Channel, ChannelInfo, ChannelStatus, InboundMessage, OutboundMessage, WebChannelOptions } from "./channels/index.js";

export { CronManager, createDefaultCronManager, parseCronExpr, parseDuration, parseTimeArg, nextRunAfter } from "./cron/index.js";
export type { CronManagerOptions, AddTaskSpec, AddTaskResult, CompleteRunResult, CronTask, CronRun, CronSchedule, CronTrigger, CronTaskKind, CronTaskStatus, CronRunStatus, CronTriggerSource } from "./cron/index.js";

export { RagStore, createRagService, createEmbedder, fuseResults } from "./rag/index.js";
export type { RagService, Embedder, RagDoc, RagChunk, RetrievedChunk, IngestSummary } from "./rag/index.js";

export { CommandDispatcher, createDefaultCommandDispatcher, DEFAULT_COMMANDS } from "./commands/index.js";
export type { Command, CommandContext, ModelSwitcher } from "./commands/index.js";

export {
  SecurityManager,
  createSecurityManager,
  RoleManager,
  BashRiskMonitor,
  HookManager,
  createBuiltinHooks,
  DeniedIntentGuard,
  extractTargets,
  evaluatePolicy,
  isRole,
  DEFAULT_CHANNEL_ROLE,
  SECURITY_STATE_FILENAME,
  SHELL_TOOL_NAME,
} from "./security/index.js";
export type {
  Actor,
  BeforeHookResult,
  BeforeHookOutcome,
  Hook,
  HookInput,
  PolicyInput,
  RiskClassification,
  RiskLevel,
  RiskRule,
  Role,
  SecurityAction,
  SecurityDecision,
  SecurityOptions,
  SecurityState,
} from "./security/index.js";

export { version } from "./version.js";
