import "dotenv/config";
import path from "node:path";

export interface AppConfig {
  provider: string;
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

// TODO: use Vercel AI SDK provider registry instead of manual config
export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const provider = overrides.provider || process.env.DEFAULT_PROVIDER || "openai";
  const model = overrides.model || process.env.DEFAULT_MODEL || "gpt-4o";
  const apiKey = process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.OPENAI_BASE_URL;
  const cwd = overrides.cwd ? path.resolve(overrides.cwd) : process.cwd();

  if (!apiKey) {
    throw new Error(
      `Missing API key. Set OPENAI_API_KEY in .env or environment variables.`
    );
  }

  return { provider, model, apiKey, baseUrl, cwd };
}
