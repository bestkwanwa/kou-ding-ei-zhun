export { runAgent, SYSTEM_PROMPT, AgentError } from "./agent/index.js";
export type { AgentOptions } from "./agent/index.js";

export { loadConfig } from "./config/index.js";
export type { AppConfig, ConfigOverrides, ProviderName } from "./config/index.js";

export { createModelFactory } from "./llm/index.js";
export type { ModelFactory, LanguageModelV3 } from "./llm/index.js";

export { ToolRegistry, createDefaultRegistry, createRegistryWithMcp } from "./tools/index.js";
export type { Tool, ToolContext } from "./tools/index.js";

export { McpClient } from "./mcp/index.js";
export type { McpServerConfig } from "./mcp/index.js";

export { version } from "./version.js";
