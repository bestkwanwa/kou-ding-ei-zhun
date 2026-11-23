import "dotenv/config";
import path from "node:path";

export type ProviderName = "zhipu" | "openai" | "anthropic";

export interface AppConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
  cwd: string;
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

/** 无显式 DEFAULT_PROVIDER 时，按已配置的 API key 自动探测（PROVIDER_DEFAULTS 声明序） */
function detectProviderFromEnv(): ProviderName | null {
  for (const name of Object.keys(PROVIDER_DEFAULTS) as ProviderName[]) {
    if (process.env[PROVIDER_DEFAULTS[name].envKey]) return name;
  }
  return null;
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const provider = resolveProvider(
    overrides.provider || process.env.DEFAULT_PROVIDER || detectProviderFromEnv() || "zhipu"
  );
  const defaults = PROVIDER_DEFAULTS[provider];
  const model = overrides.model || process.env.DEFAULT_MODEL || defaults.model;
  const apiKey = process.env[defaults.envKey] || "";
  const baseUrl = process.env[defaults.baseEnvKey] || undefined;
  const cwd = overrides.cwd ? path.resolve(overrides.cwd) : process.cwd();

  if (!apiKey) {
    const allKeys = (Object.keys(PROVIDER_DEFAULTS) as ProviderName[])
      .map((n) => PROVIDER_DEFAULTS[n].envKey)
      .join(" / ");
    throw new Error(
      `Missing API key for provider "${provider}". Set ${defaults.envKey} in .env, or use another provider (${allKeys}) with DEFAULT_PROVIDER.`
    );
  }

  return { provider, model, apiKey, baseUrl, cwd };
}
