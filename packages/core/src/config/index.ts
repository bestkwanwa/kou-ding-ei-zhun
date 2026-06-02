import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../mcp/client.js";

export type ProviderName = "zhipu" | "openai" | "anthropic";

export interface AppConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
  cwd: string;
  mcpServers?: McpServerConfig[];
}

export interface ConfigOverrides {
  provider?: string;
  model?: string;
  cwd?: string;
}

const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; envKey: string; baseEnvKey: string }> = {
  zhipu: { model: "glm-5.1", envKey: "ZHIPU_API_KEY", baseEnvKey: "ZHIPU_BASE_URL" },
  openai: { model: "gpt-4o", envKey: "OPENAI_API_KEY", baseEnvKey: "OPENAI_BASE_URL" },
  anthropic: { model: "claude-sonnet-4-20250514", envKey: "ANTHROPIC_API_KEY", baseEnvKey: "ANTHROPIC_BASE_URL" },
};

function resolveProvider(name: string): ProviderName {
  if (name in PROVIDER_DEFAULTS) return name as ProviderName;
  throw new Error(`Unknown provider "${name}". Supported: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
}

interface KdaConfigFile {
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

function loadMcpServers(cwd: string): McpServerConfig[] | undefined {
  const configPath = path.join(cwd, "kda.json");
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as KdaConfigFile;
    if (!config.mcpServers) return undefined;

    return Object.entries(config.mcpServers).map(([name, server]) => ({
      name,
      command: server.command,
      args: server.args ?? [],
      env: server.env,
    }));
  } catch {
    return undefined;
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const provider = resolveProvider(
    overrides.provider || process.env.DEFAULT_PROVIDER || "zhipu"
  );
  const defaults = PROVIDER_DEFAULTS[provider];
  const model = overrides.model || process.env.DEFAULT_MODEL || defaults.model;
  const apiKey = process.env[defaults.envKey] || "";
  const baseUrl = process.env[defaults.baseEnvKey] || undefined;
  const cwd = overrides.cwd ? path.resolve(overrides.cwd) : process.cwd();

  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider}". Set ${defaults.envKey} in .env or environment variables.`
    );
  }

  const mcpServers = loadMcpServers(cwd);

  return { provider, model, apiKey, baseUrl, cwd, mcpServers };
}
