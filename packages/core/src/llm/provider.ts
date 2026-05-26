import type { LanguageModelV3 } from "@ai-sdk/provider";
import { zhipu, createZhipu } from "zhipu-ai-provider";
import type { AppConfig } from "../config/index.js";

export type ModelFactory = (modelId: string) => LanguageModelV3;

const PROVIDER_FACTORIES: Record<string, (config: AppConfig) => ModelFactory> = {
  zhipu(config) {
    const provider = config.baseUrl
      ? createZhipu({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        })
      : zhipu;
    return (modelId) => provider(modelId);
  },
};

export function createModelFactory(config: AppConfig): ModelFactory {
  const factory = PROVIDER_FACTORIES[config.provider];
  if (!factory) {
    throw new Error(
      `Unsupported provider: "${config.provider}". Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
    );
  }
  return factory(config);
}
