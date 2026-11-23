import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createZhipu } from "zhipu-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { AppConfig, ProviderName } from "../config/index.js";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type ModelFactory = (modelId: string) => LanguageModelV3;

let requestLogInitialized = false;

/** 创建带请求日志的 fetch wrapper */
function createLoggingFetch(cwd: string): typeof globalThis.fetch {
  const logDir = resolve(cwd, ".kda", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, "request.log");
  const ts = () => new Date().toISOString();

  // Clear log on first call (new session)
  if (!requestLogInitialized) {
    writeFileSync(logPath, `[${ts()}] === request log started ===\n\n`);
    requestLogInitialized = true;
  }

  return async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        appendFileSync(
          logPath,
          `[${ts()}] [raw-request] ${init.method ?? "POST"} ${typeof input === "string" ? input : (input as URL).toString()}\n${JSON.stringify(body, null, 2)}\n\n`,
        );
      } catch {
        // ignore parse errors
      }
    }

    const response = await globalThis.fetch(input, init);

    // Clone response to log stream without consuming the original
    const [stream1, stream2] = response.body!.tee();
    const logResponse = new Response(stream2, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // Asynchronously capture stream, reconstruct complete response, log once
    (async () => {
      const reader = stream1.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      } catch {
        // ignore read errors
      }

      // Parse SSE: find the last complete data payload before [DONE]
      const lines = raw.split("\n");
      const dataLines = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((l) => l && l !== "[DONE]");

      if (dataLines.length === 0) {
        appendFileSync(logPath, `[${ts()}] [raw-response] ${response.status} ${response.statusText}\n(no data)\n\n`);
        return;
      }

      // Reconstruct full response from all SSE chunks
      const fullParts = dataLines.map((line) => JSON.parse(line));
      const fullResponse = fullParts.length === 1
        ? fullParts[0]
        : fullParts;
      appendFileSync(
        logPath,
        `[${ts()}] [raw-response] ${response.status} ${response.statusText}\n${JSON.stringify(fullResponse, null, 2)}\n\n`,
      );
    })();

    return logResponse;
  };
}

const PROVIDER_FACTORIES: Record<ProviderName, (config: AppConfig) => ModelFactory> = {
  zhipu(config) {
    const provider = createZhipu({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      fetch: createLoggingFetch(config.cwd),
    });
    return (modelId) => provider(modelId);
  },
  openai(config) {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      fetch: createLoggingFetch(config.cwd),
    });
    return (modelId) => provider(modelId);
  },
  anthropic(config) {
    const provider = createAnthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      fetch: createLoggingFetch(config.cwd),
    });
    return (modelId) => provider(modelId);
  },
};

export function createModelFactory(config: AppConfig): ModelFactory {
  // 未知供应商已在 loadConfig 的 resolveProvider 处拦截，此处映射为全函数
  return PROVIDER_FACTORIES[config.provider](config);
}
