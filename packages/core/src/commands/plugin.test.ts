import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginCommand } from "./plugin.js";
import { PluginManager } from "../plugins/index.js";
import { ToolRegistry } from "../tools/registry.js";

// --- Helpers ---

let dir: string;

function makeCtx(): { cwd: string; plugins: PluginManager } {
  dir = mkdtempSync(join(tmpdir(), "kda-plugin-cmd-"));
  return { cwd: dir, plugins: new PluginManager(dir) };
}

function seedPlugin(ctx: { cwd: string }, name: string): void {
  const pluginDir = join(ctx.cwd, ".kda", "plugins", name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "index.mjs"),
    `export default function definePlugin() {
  return {
    name: "${name}",
    version: "1.0.0",
    description: "test plugin ${name}",
    setup(ctx) {
      ctx.registerTool({
        name: "run",
        description: "run ${name}",
        parameters: { type: "object", properties: {} },
        async execute() { return "${name} ok"; },
      });
    },
  };
}
`,
    "utf-8",
  );
}

/** ctx + 真实加载（list 的 enabled 信息需 loadAll 后才有） */
async function makeLoadedCtx(): Promise<{ cwd: string; plugins: PluginManager }> {
  const ctx = makeCtx();
  seedPlugin(ctx, "alpha");
  await ctx.plugins.loadAll(new ToolRegistry());
  return ctx;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("/plugin command", () => {
  it("defaults to list and shows plugins with status markers", async () => {
    const ctx = await makeLoadedCtx();
    const out = pluginCommand.execute("", ctx);
    expect(out).toContain("Plugins (1)");
    expect(out).toContain("alpha");
    expect(out).toContain("[enabled]");
    expect(out).toContain("v1.0.0");
    expect(out).toContain("(tools: alpha_run)");
  });

  it("list marks disabled plugins", async () => {
    const ctx = await makeLoadedCtx();
    ctx.plugins.disable("alpha");
    const out = pluginCommand.execute("list", ctx);
    expect(out).toContain("[disabled]");
    expect(out).not.toContain("v1.0.0");
  });

  it("list on empty store reports no plugins", () => {
    const ctx = makeCtx();
    const out = pluginCommand.execute("list", ctx);
    expect(out).toContain("No plugins found");
    expect(out).toContain(".kda/plugins/<name>/index.mjs");
  });

  it("disable writes state that a fresh manager honors, enable restores", async () => {
    const ctx = await makeLoadedCtx();
    expect(pluginCommand.execute("disable alpha", ctx)).toContain('Plugin "alpha" disabled');
    expect(pluginCommand.execute("disable alpha", ctx)).toContain("takes effect on next start");

    // 状态文件实际生效：全新 manager + loadAll 后跳过
    const registry = new ToolRegistry();
    await new PluginManager(ctx.cwd).loadAll(registry);
    expect(registry.get("alpha_run")).toBeUndefined();

    expect(pluginCommand.execute("enable alpha", ctx)).toContain('Plugin "alpha" enabled');
    const registry2 = new ToolRegistry();
    await new PluginManager(ctx.cwd).loadAll(registry2);
    expect(registry2.get("alpha_run")).toBeDefined();
  });

  it("enable/disable with unknown name or missing arg is helpful", () => {
    const ctx = makeCtx();
    seedPlugin(ctx, "alpha");
    expect(pluginCommand.execute("enable nope", ctx)).toContain('Plugin "nope" not found');
    expect(pluginCommand.execute("disable nope", ctx)).toContain("Existing: alpha");
    expect(pluginCommand.execute("enable", ctx)).toContain("Usage: /plugin enable <name>");
    expect(pluginCommand.execute("disable", ctx)).toContain("Usage: /plugin disable <name>");
  });

  it("help / unknown action prints usage", () => {
    const ctx = makeCtx();
    for (const args of ["help", "explode"]) {
      expect(pluginCommand.execute(args, ctx)).toContain("Usage: /plugin");
    }
    expect(pluginCommand.execute("help", ctx)).toContain("PLUGIN_<NAME>__<KEY>");
  });

  it("guards when plugin manager is not injected", () => {
    expect(pluginCommand.execute("list", { cwd: "/tmp" })).toContain("Plugins are not available");
  });
});
