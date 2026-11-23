import { describe, it, expect } from "vitest";
import { modelCommand } from "./model.js";
import type { CommandContext, ModelSwitcher } from "./types.js";

function makeCtx(withSwitcher = true): CommandContext {
  const ctx: CommandContext = { cwd: "/tmp" };
  if (withSwitcher) {
    const switcher: ModelSwitcher = {
      provider: "zhipu",
      get: () => current,
      set: (id) => {
        current = id;
      },
    };
    let current = "glm-5.1";
    Object.assign(ctx, { model: switcher });
  }
  return ctx;
}

describe("modelCommand", () => {
  it("is wired with name/usage for the dispatcher", () => {
    expect(modelCommand.name).toBe("model");
    expect(modelCommand.usage).toBe("/model [model-id]");
  });

  it("reports unavailable when ctx has no switcher", () => {
    expect(modelCommand.execute("", makeCtx(false))).toBe("Model switching is not available.");
  });

  it("shows the current provider/model by default", () => {
    const out = modelCommand.execute("", makeCtx());
    expect(out).toContain("zhipu/glm-5.1");
    expect(out).toContain("/model <model-id>");
  });

  it("switches the model through the switcher", () => {
    const ctx = makeCtx();
    const out = modelCommand.execute("glm-4.7", ctx);
    expect(out).toContain("glm-4.7");
    expect(out).toContain("next turn");
    expect(ctx.model?.get()).toBe("glm-4.7");
  });

  it("rejects multi-token input instead of setting garbage", () => {
    const ctx = makeCtx();
    expect(modelCommand.execute("use the fast one", ctx)).toBe("Usage: /model [model-id]");
    expect(ctx.model?.get()).toBe("glm-5.1"); // 未被切换
  });

  it("help shows usage", () => {
    expect(modelCommand.execute("help", makeCtx())).toContain("Usage: /model");
  });
});
