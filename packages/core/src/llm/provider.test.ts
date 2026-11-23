import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelFactory } from "./provider.js";
import type { AppConfig, ProviderName } from "../config/index.js";

describe("createModelFactory", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("constructs a model for every supported provider (offline, no request)", () => {
    for (const provider of ["zhipu", "openai", "anthropic"] as ProviderName[]) {
      const cwd = mkdtempSync(join(tmpdir(), `kda-provider-${provider}-`));
      dirs.push(cwd);
      const config: AppConfig = { provider, model: "test-model", apiKey: "test-key", cwd };
      const model = createModelFactory(config)("test-model");
      expect(model).toBeTruthy();
      expect(typeof model.doGenerate).toBe("function");
    }
  });
});
