import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, parsePluginEnv } from "./manager.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read_file.js";

// --- Helpers ---

let dir: string;
let warnSpy: MockInstance;

// 每个用例独立 tmp 目录：动态 import 按 URL 缓存，绝不能重写同一路径再 import
function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-plugin-mgr-"));
  return dir;
}

function seedPlugin(cwd: string, name: string, entry: string, code: string): string {
  const pluginDir = join(cwd, ".kda", "plugins", name);
  mkdirSync(pluginDir, { recursive: true });
  const file = join(pluginDir, entry);
  writeFileSync(file, code, "utf-8");
  return file;
}

/** 标准 ESM plugin fixture：注册一个返回 greeting 的工具 */
function esmPlugin(name: string, toolName: string, greeting: string): string {
  return `export default function definePlugin() {
  return {
    name: "${name}",
    version: "1.0.0",
    description: "test plugin ${name}",
    setup(ctx) {
      ctx.registerTool({
        name: "${toolName}",
        description: "Test tool ${toolName}",
        parameters: { type: "object", properties: {} },
        async execute() { return "${greeting}"; },
      });
    },
  };
}
`;
}

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject: parsePluginEnv（纯函数） ---

describe("parsePluginEnv", () => {
  it("groups PLUGIN_<NAME>__<KEY> vars per plugin with kebab name mapping", () => {
    const map = parsePluginEnv({
      PLUGIN_HELLO__GREETING: "hi",
      PLUGIN_MY_TOOL__API_KEY: "secret",
      UNRELATED: "z",
    });
    expect(map.get("hello")).toEqual({ GREETING: "hi" });
    expect(map.get("my-tool")).toEqual({ API_KEY: "secret" });
    expect(map.size).toBe(2);
  });

  it("splits on the first double underscore", () => {
    const map = parsePluginEnv({ PLUGIN_MY__TOOL__A: "v" });
    expect(map.get("my")).toEqual({ "TOOL__A": "v" });
  });

  it("ignores malformed vars (empty name/key, plain PLUGIN_ prefix)", () => {
    const map = parsePluginEnv({ PLUGIN__X: "1", PLUGIN_FOO__: "2", PLUGIN_NOSEP: "3", FOO__BAR: "4" });
    expect(map.size).toBe(0);
  });
});

// --- Subject: PluginManager.loadAll ---

describe("PluginManager.loadAll", () => {
  it("is a no-op when .kda/plugins/ does not exist", async () => {
    const cwd = makeCwd();
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await expect(mgr.loadAll(registry)).resolves.toBeUndefined();
    expect(mgr.list()).toEqual([]);
  });

  it("loads an enabled plugin, registers prefixed tools, and exposes info via list()", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "hello", "index.mjs", esmPlugin("hello", "greet", "hi"));
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);

    const tool = registry.get("hello_greet");
    expect(tool).toBeDefined();
    expect(await tool!.execute({}, { cwd })).toBe("hi");
    expect(mgr.list()).toEqual([
      { name: "hello", version: "1.0.0", description: "test plugin hello", status: "enabled", tools: ["hello_greet"] },
    ]);
  });

  it("injects parsed PLUGIN_<NAME>__* env vars via getConfig()", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "cfg",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "cfg",
    version: "1.0.0",
    description: "capture config",
    setup(ctx) {
      const config = ctx.getConfig();
      ctx.registerTool({
        name: "show",
        description: "show config",
        parameters: { type: "object", properties: {} },
        async execute() { return JSON.stringify(config); },
      });
    },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry, { PLUGIN_CFG__GREETING: "hi", PLUGIN_OTHER__X: "1", UNRELATED: "z" });
    expect(await registry.get("cfg_show")!.execute({}, { cwd })).toBe(JSON.stringify({ GREETING: "hi" }));
  });

  it("skips a tool whose prefixed name collides with an existing tool (no overwrite)", async () => {
    const cwd = makeCwd();
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    seedPlugin(cwd, "read", "index.mjs", esmPlugin("read", "file", "mine"));
    const mgr = new PluginManager(cwd);
    await mgr.loadAll(registry);

    expect(registry.get("read_file")).toBe(readFileTool); // 内置工具未被覆盖
    expect(mgr.list()[0].tools).toEqual([]); // 冲突工具被跳过
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"read_file" already registered`));
  });

  it("skips a duplicate tool name within one plugin", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "dup",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "dup",
    version: "1.0.0",
    description: "dup",
    setup(ctx) {
      for (const greeting of ["first", "second"]) {
        ctx.registerTool({
          name: "same",
          description: "dup tool",
          parameters: { type: "object", properties: {} },
          async execute() { return greeting; },
        });
      }
    },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(await registry.get("dup_same")!.execute({}, { cwd })).toBe("first");
    expect(mgr.list()[0].tools).toEqual(["dup_same"]);
  });

  it("caps tools per plugin at MAX_TOOLS_PER_PLUGIN", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "many",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "many",
    version: "1.0.0",
    description: "many tools",
    setup(ctx) {
      for (let i = 0; i < 55; i++) {
        ctx.registerTool({
          name: "t" + i,
          description: "tool " + i,
          parameters: { type: "object", properties: {} },
          async execute() { return "ok"; },
        });
      }
    },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(registry.get("many_t49")).toBeDefined();
    expect(registry.get("many_t50")).toBeUndefined();
    expect(mgr.list()[0].tools.length).toBe(50);
  });

  it("isolates a throwing setup: plugin errors, buffered tools discarded, siblings still load", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "bad",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "bad",
    version: "1.0.0",
    description: "throws in setup",
    async setup(ctx) {
      ctx.registerTool({
        name: "never",
        description: "never registered",
        parameters: { type: "object", properties: {} },
        async execute() { return "nope"; },
      });
      throw new Error("boom");
    },
    async dispose() { throw new Error("cleanup also fails"); },
  };
}
`,
    );
    seedPlugin(cwd, "good", "index.mjs", esmPlugin("good", "tool", "fine"));
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);

    expect(registry.get("bad_never")).toBeUndefined();
    expect(registry.get("good_tool")).toBeDefined();
    const bad = mgr.list().find((p) => p.name === "bad")!;
    expect(bad.status).toBe("error");
    expect(bad.error).toContain("setup failed: boom");
  });

  it("isolates a syntax-error entry file", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "broken", "index.mjs", "export default function ( {");
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await expect(mgr.loadAll(registry)).resolves.toBeUndefined();
    expect(mgr.list()[0].status).toBe("error");
  });

  it("fails when definition name does not match directory name", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "foo", "index.mjs", esmPlugin("bar", "tool", "x"));
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(mgr.list()[0].status).toBe("error");
    expect(mgr.list()[0].error).toContain('does not match directory name "foo"');
  });

  it("fails when no entry file exists", async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".kda", "plugins", "empty"), { recursive: true });
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(mgr.list()[0].error).toContain("no entry file");
  });

  it("fails when default export is not a function", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "notfn", "index.mjs", "export default { name: 'notfn' };");
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(mgr.list()[0].error).toContain("default export must be a function");
  });

  it("loads a CJS .js entry (module.exports)", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "legacy",
      "index.js",
      `module.exports = function definePlugin() {
  return {
    name: "legacy",
    version: "0.1.0",
    description: "cjs plugin",
    setup(ctx) {
      ctx.registerTool({
        name: "old",
        description: "old tool",
        parameters: { type: "object", properties: {} },
        async execute() { return "from cjs"; },
      });
    },
  };
};
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(await registry.get("legacy_old")!.execute({}, { cwd })).toBe("from cjs");
  });

  it("falls back to the next candidate entry (.mjs preferred over .js)", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "pref", "index.mjs", esmPlugin("pref", "from_mjs", "mjs"));
    seedPlugin(cwd, "pref", "index.js", `module.exports = function () { throw new Error("js must not load"); };`);
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(await registry.get("pref_from_mjs")!.execute({}, { cwd })).toBe("mjs");
  });

  it("tolerates an unsupported .ts entry by falling through to .mjs (identical contract)", async () => {
    const cwd = makeCwd();
    // Node < 22.18/23.6 报 ERR_UNKNOWN_FILE_EXTENSION 回退 .mjs；新版 Node 直接加载 .ts。两份契约一致。
    seedPlugin(cwd, "dual", "index.ts", esmPlugin("dual", "entry", "loaded"));
    seedPlugin(cwd, "dual", "index.mjs", esmPlugin("dual", "entry", "loaded"));
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);
    expect(await registry.get("dual_entry")!.execute({}, { cwd })).toBe("loaded");
  });

  it("ignores registerTool calls made after setup completed", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "late",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "late",
    version: "1.0.0",
    description: "late register",
    setup(ctx) { globalThis.__latePluginCtx = ctx; },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);

    const lateCtx = (globalThis as { __latePluginCtx?: { registerTool(t: unknown): void } }).__latePluginCtx!;
    lateCtx.registerTool({
      name: "toolate",
      description: "too late",
      parameters: { type: "object", properties: {} },
      async execute() { return "never"; },
    });
    expect(registry.get("late_toolate")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("after setup is ignored"));
  });

  it("passes through parallelizable and lazy flags to the registry", async () => {
    const cwd = makeCwd();
    seedPlugin(
      cwd,
      "flags",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "flags",
    version: "1.0.0",
    description: "flag passthrough",
    setup(ctx) {
      ctx.registerTool({
        name: "par",
        description: "parallel tool",
        parameters: { type: "object", properties: {} },
        async execute() { return "ok"; },
        parallelizable: true,
      });
      ctx.registerTool({
        name: "hid",
        description: "Hidden tool for search_tools.",
        parameters: { type: "object", properties: {} },
        async execute() { return "ok"; },
        lazy: true,
        hint: "hidden",
      });
    },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    const registry = new ToolRegistry();
    await mgr.loadAll(registry);

    expect(registry.getParallelizableToolNames().has("flags_par")).toBe(true);
    expect(Object.keys(registry.toAiSdkDefinitions())).not.toContain("flags_hid");
    registry.discover("flags_hid");
    expect(Object.keys(registry.toAiSdkDefinitions())).toContain("flags_hid");
  });

  it("skips invalid directories (bad names, non-directories)", async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".kda", "plugins", "Bad_Name"), { recursive: true });
    writeFileSync(join(cwd, ".kda", "plugins", "stray.txt"), "x", "utf-8");
    const mgr = new PluginManager(cwd);
    await mgr.loadAll(new ToolRegistry());
    expect(mgr.list()).toEqual([]);
  });
});

// --- Subject: enable/disable 状态持久化 ---

describe("PluginManager enable/disable", () => {
  it("disable persists to state file and a fresh load skips the plugin; enable restores it", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "hello", "index.mjs", esmPlugin("hello", "greet", "hi"));

    const mgr1 = new PluginManager(cwd);
    expect(mgr1.disable("hello")).toBe("ok");
    expect(JSON.parse(readFileSync(join(cwd, ".kda", "plugins.json"), "utf-8"))).toEqual({ disabled: ["hello"] });
    expect(mgr1.disable("hello")).toBe("ok"); // 幂等

    const registry = new ToolRegistry();
    await new PluginManager(cwd).loadAll(registry);
    expect(registry.get("hello_greet")).toBeUndefined();
    expect(new PluginManager(cwd).list()[0].status).toBe("disabled");

    expect(mgr1.enable("hello")).toBe("ok");
    const registry2 = new ToolRegistry();
    await new PluginManager(cwd).loadAll(registry2);
    expect(registry2.get("hello_greet")).toBeDefined();
  });

  it("returns not-found for unknown plugin names", () => {
    const cwd = makeCwd();
    const mgr = new PluginManager(cwd);
    expect(mgr.enable("ghost")).toBe("not-found");
    expect(mgr.disable("ghost")).toBe("not-found");
  });

  it("treats a corrupt state file as all-enabled", async () => {
    const cwd = makeCwd();
    seedPlugin(cwd, "hello", "index.mjs", esmPlugin("hello", "greet", "hi"));
    mkdirSync(join(cwd, ".kda"), { recursive: true });
    writeFileSync(join(cwd, ".kda", "plugins.json"), "{ not json", "utf-8");

    const registry = new ToolRegistry();
    await new PluginManager(cwd).loadAll(registry);
    expect(registry.get("hello_greet")).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// --- Subject: disposeAll ---

describe("PluginManager.disposeAll", () => {
  it("calls dispose on each plugin, swallows throwing disposes, and is idempotent", async () => {
    const cwd = makeCwd();
    const marker = join(cwd, "marker.txt");
    seedPlugin(
      cwd,
      "calm",
      "index.mjs",
      `import { appendFileSync } from "node:fs";
export default function definePlugin() {
  return {
    name: "calm",
    version: "1.0.0",
    description: "clean exit",
    setup() {},
    dispose() { appendFileSync(${JSON.stringify(marker)}, "calm\\n", "utf-8"); },
  };
}
`,
    );
    seedPlugin(
      cwd,
      "angry",
      "index.mjs",
      `export default function definePlugin() {
  return {
    name: "angry",
    version: "1.0.0",
    description: "throws on dispose",
    setup() {},
    dispose() { throw new Error("dispose boom"); },
  };
}
`,
    );
    const mgr = new PluginManager(cwd);
    await mgr.loadAll(new ToolRegistry());

    await expect(mgr.disposeAll()).resolves.toBeUndefined();
    await expect(mgr.disposeAll()).resolves.toBeUndefined(); // 幂等
    expect(readFileSync(marker, "utf-8")).toBe("calm\n");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dispose failed"));
  });
});
