import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { jsonSchema, type Schema } from "ai";
import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  MAX_TOOLS_PER_PLUGIN,
  PLUGIN_ENTRY_CANDIDATES,
  PLUGIN_NAME_RE,
  PLUGIN_STATE_FILENAME,
  PLUGIN_TOOL_NAME_RE,
  type PluginContext,
  type PluginDefinition,
  type PluginInfo,
  type PluginToolSpec,
} from "./types.js";

/**
 * 环境变量 → plugin 配置分组：PLUGIN_<NAME>__<KEY>（第一个 "__" 分隔，<NAME> 大写、"-"→"_"）。
 * 例：PLUGIN_MY_TOOL__API_KEY → plugin "my-tool" 的 { API_KEY: "..." }。
 * 名字含下划线时以第一个 "__" 为界：PLUGIN_MY__TOOL__A → plugin "my"、key "TOOL__A"。
 */
export function parsePluginEnv(env: NodeJS.ProcessEnv): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const m = /^PLUGIN_([A-Z0-9_]+?)__(.+)$/.exec(key);
    if (!m) continue;
    const pluginName = m[1].toLowerCase().replace(/_/g, "-");
    let config = map.get(pluginName);
    if (!config) {
      config = {};
      map.set(pluginName, config);
    }
    config[m[2]] = String(value);
  }
  return map;
}

interface LoadedPlugin {
  def: PluginDefinition;
  /** 实际注册成功的前缀工具名 */
  tools: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Plugin 管理器：扫描 .kda/plugins/、动态加载、工具注册（加 pluginName_ 前缀）、
 * enable/disable 状态持久化、退出清理。对调用方永不抛错（错误隔离到单个 plugin）。
 */
export class PluginManager {
  private readonly pluginsDir: string;
  private readonly statePath: string;
  private readonly log: Logger;
  private loaded = new Map<string, LoadedPlugin>();
  private errors = new Map<string, string>();

  constructor(private cwd: string) {
    this.pluginsDir = resolve(cwd, ".kda", "plugins");
    this.statePath = resolve(cwd, ".kda", PLUGIN_STATE_FILENAME);
    this.log = createLogger(cwd);
  }

  /**
   * 扫描并加载全部启用的 plugin，工具注册进 registry。
   * 必须在 runAgent 之前调用：toolDefs 在 agent 启动时快照，晚注册的工具 LLM 不可见。
   */
  async loadAll(registry: ToolRegistry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const disabled = this.readDisabled();
    for (const name of this.scanDirs()) {
      if (disabled.has(name)) continue;
      await this.loadOne(name, registry, env);
    }
  }

  /** 全部磁盘上的 plugin 及状态（按名排序；disabled/未加载者无版本信息） */
  list(): PluginInfo[] {
    const disabled = this.readDisabled();
    return this.scanDirs().map((name): PluginInfo => {
      // 禁用意图持久化后展示优先（工具本会话仍在，但 /plugin disable 已声明下次不再加载）
      if (disabled.has(name)) return { name, version: "", description: "", status: "disabled", tools: [] };
      const loadedPlugin = this.loaded.get(name);
      if (loadedPlugin) {
        return {
          name,
          version: loadedPlugin.def.version,
          description: loadedPlugin.def.description,
          status: "enabled",
          tools: [...loadedPlugin.tools],
        };
      }
      const error = this.errors.get(name);
      if (error) return { name, version: "", description: "", status: "error", tools: [], error };
      // 未加载也未出错也未禁用：loadAll 尚未运行（如 --no-tools 模式）
      return { name, version: "", description: "", status: "enabled", tools: [] };
    });
  }

  /** 启用（从 disabled 列表移除），幂等；下次启动生效 */
  enable(name: string): "ok" | "not-found" | "io-error" {
    if (!this.scanDirs().includes(name)) return "not-found";
    const disabled = this.readDisabled();
    if (!disabled.has(name)) return "ok";
    disabled.delete(name);
    return this.writeDisabled(disabled);
  }

  /** 禁用（加入 disabled 列表），幂等；下次启动生效（运行中的注册表无注销机制） */
  disable(name: string): "ok" | "not-found" | "io-error" {
    if (!this.scanDirs().includes(name)) return "not-found";
    const disabled = this.readDisabled();
    disabled.add(name);
    return this.writeDisabled(disabled);
  }

  /** 逐个调用已加载 plugin 的 dispose()，单个失败只警告不中断；幂等 */
  async disposeAll(): Promise<void> {
    for (const [name, { def }] of this.loaded) {
      try {
        await def.dispose?.();
      } catch (err) {
        console.warn(chalk.yellow(`[plugin:${name}] dispose failed: ${errorMessage(err)}`));
      }
    }
    this.loaded.clear();
  }

  // --- 内部实现 ---

  /** 扫描 .kda/plugins/，只认合法命名的目录（目录名即 plugin 名），按名排序 */
  private scanDirs(): string[] {
    try {
      const entries = readdirSync(this.pluginsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PLUGIN_NAME_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return []; // 目录缺失等，静默（/plugin list 报告为空）
    }
  }

  /** 读取 disabled 集合；无状态文件 = 全启用（默认，不告警）；损坏 = 全启用 + 单次警告 */
  private readDisabled(): Set<string> {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      console.warn(chalk.yellow(`[plugin] could not read ${PLUGIN_STATE_FILENAME}, treating all plugins as enabled`));
      return new Set();
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null && typeof parsed === "object" &&
        Array.isArray((parsed as { disabled?: unknown }).disabled) &&
        (parsed as { disabled: unknown[] }).disabled.every((x) => typeof x === "string")
      ) {
        return new Set((parsed as { disabled: string[] }).disabled);
      }
    } catch {
      // JSON 语法错误，落到下方统一警告
    }
    console.warn(chalk.yellow(`[plugin] invalid ${PLUGIN_STATE_FILENAME}, treating all plugins as enabled`));
    return new Set();
  }

  private writeDisabled(disabled: Set<string>): "ok" | "io-error" {
    try {
      mkdirSync(resolve(this.cwd, ".kda"), { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, "utf-8");
      return "ok";
    } catch {
      return "io-error";
    }
  }

  private async loadOne(name: string, registry: ToolRegistry, env: NodeJS.ProcessEnv): Promise<void> {
    // 入口解析：按序取存在的候选；.ts 在不支持 type stripping 的运行时（Node < 22.18/23.6）
    // import 时报 ERR_UNKNOWN_FILE_EXTENSION，仅此错误码回退下一候选，不掩盖真实错误
    const candidates = PLUGIN_ENTRY_CANDIDATES.map((c) => resolve(this.pluginsDir, name, c)).filter((p) =>
      existsSync(p),
    );
    if (candidates.length === 0) {
      return this.fail(name, "no entry file (expected index.ts | index.mjs | index.js)");
    }

    let mod: { default?: unknown };
    let importErr: unknown;
    let imported = false;
    for (const candidate of candidates) {
      try {
        mod = (await import(pathToFileURL(candidate).href)) as { default?: unknown };
        imported = true;
        break;
      } catch (err) {
        importErr = err;
        if ((err as NodeJS.ErrnoException)?.code === "ERR_UNKNOWN_FILE_EXTENSION") continue;
        break;
      }
    }
    if (!imported) return this.fail(name, `failed to import: ${errorMessage(importErr)}`);

    // .kda/ 下无 package.json，.js 按 CJS 解析 → 兼容 module.exports / export default 两种形态
    const factory = mod!.default ?? mod!;
    if (typeof factory !== "function") return this.fail(name, "default export must be a function");

    let def: PluginDefinition;
    try {
      def = (await factory()) as PluginDefinition;
    } catch (err) {
      return this.fail(name, `definePlugin() failed: ${errorMessage(err)}`);
    }
    if (def === null || typeof def !== "object") return this.fail(name, "definePlugin() must return an object");
    if (def.name !== name) {
      return this.fail(name, `definition name "${String(def.name)}" does not match directory name "${name}"`);
    }
    if (typeof def.setup !== "function") return this.fail(name, "setup must be a function");
    const version = typeof def.version === "string" && def.version ? def.version : "0.0.0";
    const description = typeof def.description === "string" && def.description ? def.description : "(no description)";

    // 暂存注册（staged registration）：setup 成功才提交，失败的 setup 不留半注册状态
    const config = Object.freeze({ ...parsePluginEnv(env).get(name) }) as Record<string, string>;
    const buffered: PluginToolSpec[] = [];
    let setupDone = false;

    const ctx: PluginContext = {
      registerTool: (spec) => {
        if (setupDone) {
          console.warn(
            chalk.yellow(
              `[plugin:${name}] registerTool after setup is ignored (tool definitions are snapshotted at agent start): ${String(spec?.name)}`,
            ),
          );
          return;
        }
        const invalid = invalidToolSpec(spec);
        if (invalid) {
          console.warn(chalk.yellow(`[plugin:${name}] skipping invalid tool "${String(spec?.name)}": ${invalid}`));
          return;
        }
        if (buffered.length >= MAX_TOOLS_PER_PLUGIN) {
          console.warn(chalk.yellow(`[plugin:${name}] tool limit reached (${MAX_TOOLS_PER_PLUGIN}), skipping "${spec.name}"`));
          return;
        }
        buffered.push(spec);
      },
      getConfig: () => config,
      log: (...args) => {
        try {
          this.log.log(`[plugin:${name}]`, ...args);
        } catch {
          // 日志失败静默丢弃，不影响 plugin 运行
        }
      },
    };

    try {
      await def.setup(ctx);
    } catch (err) {
      // 暂存工具全部丢弃；plugin 可能持有半开资源，best-effort 调 dispose
      try {
        await def.dispose?.();
      } catch {
        // 清理失败忽略，错误已由 setup 报告
      }
      return this.fail(name, `setup failed: ${errorMessage(err)}`);
    }
    setupDone = true;

    // 提交：加前缀后查重（registry.register 是裸 Map.set，必须预检），冲突跳过不覆盖
    const tools: string[] = [];
    for (const spec of buffered) {
      const prefixed = `${name}_${spec.name}`;
      if (registry.get(prefixed) || tools.includes(prefixed)) {
        console.warn(chalk.yellow(`[plugin:${name}] skipping tool "${spec.name}": "${prefixed}" already registered`));
        continue;
      }
      const tool: Tool = {
        name: prefixed,
        description: spec.description,
        parameters: jsonSchema(spec.parameters) as Schema<unknown>,
        execute: spec.execute,
        readOnly: spec.readOnly,
        parallelizable: spec.parallelizable,
        maxResultLength: spec.maxResultLength,
        lazy: spec.lazy,
        hint: spec.hint,
        cleanable: spec.cleanable,
      };
      registry.register(tool);
      tools.push(prefixed);
    }

    this.loaded.set(name, { def: { ...def, version, description }, tools });
    this.log.log(`[plugin] loaded ${name} v${version} (${tools.length} tools)`);
  }

  private fail(name: string, message: string): void {
    this.errors.set(name, message);
    console.warn(chalk.yellow(`[plugin:${name}] failed to load: ${message}`));
    this.log.log(`[plugin] FAILED ${name}: ${message}`);
  }
}

/** 工具 spec 校验，返回错误描述（合法返回 null） */
function invalidToolSpec(spec: PluginToolSpec): string | null {
  if (spec === null || typeof spec !== "object") return "spec must be an object";
  if (typeof spec.name !== "string" || !PLUGIN_TOOL_NAME_RE.test(spec.name)) {
    return `tool name "${String(spec.name)}" must match ${PLUGIN_TOOL_NAME_RE}`;
  }
  if (typeof spec.description !== "string" || spec.description.trim() === "") return "description is required";
  if (spec.parameters === null || typeof spec.parameters !== "object" || Array.isArray(spec.parameters)) {
    return "parameters must be a JSON Schema object";
  }
  if (typeof spec.execute !== "function") return "execute must be a function";
  return null;
}
