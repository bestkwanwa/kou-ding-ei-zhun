import { resolve, sep } from "node:path";
import chalk from "chalk";
import type { BeforeHookResult, Hook, HookInput } from "./types.js";

/** 受路径包含约束的写工具 */
const PATH_CONTAINED_TOOLS = new Set(["write_file", "edit_file"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 内置 hook：非 owner 角色经 write_file/edit_file 写 cwd 外路径 → deny。
 * 堵上工具层缺失的 cwd 包含检查（owner 豁免——terminal 全权）。
 */
function createWritePathContainmentHook(cwd: string): Hook {
  const root = resolve(cwd) + sep;
  return {
    name: "write-path-containment",
    beforeExecute(input): BeforeHookResult {
      if (input.actor.role === "owner" || !PATH_CONTAINED_TOOLS.has(input.toolName)) {
        return { action: "allow" };
      }
      const p = input.args.path;
      if (typeof p !== "string" || p.trim() === "") return { action: "allow" }; // 缺参交给工具自身报错
      const target = resolve(cwd, p);
      if (target !== resolve(cwd) && !target.startsWith(root)) {
        return { action: "deny", reason: `${input.actor.role} role cannot write outside the project directory: ${p}` };
      }
      return { action: "allow" };
    },
  };
}

/** v1 内置 hooks（构造 HookManager 时自动注册） */
export function createBuiltinHooks(cwd: string): readonly Hook[] {
  return [createWritePathContainmentHook(cwd)];
}

export interface BeforeHookOutcome {
  decision: { action: "allow" | "deny"; reason?: string };
  /** 可能被 hook 链改写后的 args */
  args: Record<string, unknown>;
}

/**
 * 工具执行前后的通用 hook 扩展点（第三层）。注册逻辑收敛在本类：
 * 构造时自动注册内置 hooks，外部（未来的 plugin 等）可经 register() 追加。
 * before 按注册顺序执行，首个 deny 短路，args 改写链式传递；
 * after 按注册顺序执行，各自可改写结果串。抛错的 hook 被隔离（before→deny / after→原样），绝不打断主循环。
 */
export class HookManager {
  private readonly hooks: Hook[];

  constructor(builtins: readonly Hook[] = []) {
    this.hooks = [...builtins];
  }

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  /** 工具执行前：任一 hook 可 deny（附带原因）或改写 args */
  async runBefore(input: HookInput): Promise<BeforeHookOutcome> {
    let args = input.args;
    for (const hook of this.hooks) {
      if (!hook.beforeExecute) continue;
      try {
        const result = await hook.beforeExecute({ ...input, args });
        if (result.action === "deny") {
          return { decision: { action: "deny", reason: result.reason }, args };
        }
        if (result.args !== undefined) {
          args = result.args;
        }
      } catch (err) {
        console.warn(chalk.yellow(`[security] hook "${hook.name}" beforeExecute failed: ${errorMessage(err)}`));
        return { decision: { action: "deny", reason: `hook "${hook.name}" errored (fail-closed)` }, args };
      }
    }
    return { decision: { action: "allow" }, args };
  }

  /** 工具执行后：观察/改写结果串 */
  async runAfter(input: HookInput, result: string): Promise<string> {
    let current = result;
    for (const hook of this.hooks) {
      if (!hook.afterExecute) continue;
      try {
        const next = await hook.afterExecute({ ...input }, current);
        if (typeof next === "string") current = next;
      } catch (err) {
        console.warn(chalk.yellow(`[security] hook "${hook.name}" afterExecute failed: ${errorMessage(err)}`));
      }
    }
    return current;
  }
}
