import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "./index.js";

const ENV_KEYS = [
  "DEFAULT_PROVIDER",
  "DEFAULT_MODEL",
  "ZHIPU_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ZHIPU_BASE_URL",
];

describe("loadConfig provider resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function clearProviderEnv() {
    for (const k of ENV_KEYS) vi.stubEnv(k, "");
  }

  it("explicit DEFAULT_PROVIDER wins over auto-detection", () => {
    clearProviderEnv();
    vi.stubEnv("DEFAULT_PROVIDER", "openai");
    vi.stubEnv("ZHIPU_API_KEY", "zhipu-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");

    const config = loadConfig();
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("openai-key");
  });

  it("auto-detects the provider from whichever API key is set", () => {
    clearProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");

    const config = loadConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("anthropic-key");
    expect(config.model).toBe("claude-sonnet-4-20250514"); // 供应商默认模型
  });

  it("detection order follows PROVIDER_DEFAULTS declaration (zhipu first)", () => {
    clearProviderEnv();
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("ZHIPU_API_KEY", "zhipu-key");

    expect(loadConfig().provider).toBe("zhipu");
  });

  it("cli overrides beat env (provider and model)", () => {
    clearProviderEnv();
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");

    const config = loadConfig({ provider: "anthropic", model: "custom-model" });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("custom-model");
  });

  it("no key at all errors with a provider-neutral message", () => {
    clearProviderEnv();
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY.*ANTHROPIC_API_KEY|ANTHROPIC_API_KEY.*OPENAI_API_KEY/s);
  });

  it("rejects unknown provider names", () => {
    clearProviderEnv();
    vi.stubEnv("ZHIPU_API_KEY", "k");
    expect(() => loadConfig({ provider: "nope" })).toThrow('Unknown provider "nope"');
  });

  it("resolves baseUrl per provider env", () => {
    clearProviderEnv();
    vi.stubEnv("ZHIPU_API_KEY", "k");
    vi.stubEnv("ZHIPU_BASE_URL", "https://example.test/v4");
    expect(loadConfig().baseUrl).toBe("https://example.test/v4");
  });
});
