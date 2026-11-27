import { Effect } from "effect";
import chalk from "chalk";
import type { ToolCallPart } from "ai";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SecurityManager } from "../security/index.js";
import type { Logger } from "../utils/logger.js";
import { AgentError } from "./errors.js";

export interface ExecuteToolDeps {
  registry: ToolRegistry;
  security: SecurityManager;
  toolCtx: ToolContext;
  log: Logger;
}

export interface ToolExecution {
  tc: ToolCallPart;
  output: string;
  summary: string;
  isError: boolean;
}

/**
 * 单次工具执行（从 runToolLoop 提取为模块级函数，cron 的 bash 任务复用同一条管线）。
 * 安全防线串联：角色×风险判定（deny 短路 / warn 即时警告行）→ before hooks（可改写 args）
 * → 执行 → after hooks → 截断。内部消化所有错误，Effect 无失败通道。
 */
export function executeToolCall(tc: ToolCallPart, deps: ExecuteToolDeps): Effect.Effect<ToolExecution> {
  const { registry, security, toolCtx, log } = deps;
  return Effect.gen(function* () {
    const tool = registry.get(tc.toolName);
    if (!tool) {
      log.log(`[tool-error] unknown tool: ${tc.toolName}`);
      const output = `Error: unknown tool "${tc.toolName}"`;
      return { tc, output, summary: "", isError: true };
    }

    const args = tc.input as Record<string, unknown>;
    const summary = [args.path, args.command, args.pattern].find((v) => typeof v === "string") ?? "";

    // --- 第一/二层：角色 × 工具 × 风险（fail-closed：check 自身失败按 deny） ---
    const decision = yield* Effect.tryPromise({
      try: () => security.check(tool, args),
      catch: (e) => new AgentError(`Security check for "${tc.toolName}" failed`, e),
    }).pipe(
      Effect.catchTag("AgentError", (e) =>
        Effect.succeed({ action: "deny" as const, reason: `security check error: ${e.message}` }),
      ),
    );
    const actor = security.currentActor;
    if (decision.action === "deny") {
      log.log(`[security] denied ${tc.toolName} (${actor.role}/${actor.source}): ${decision.reason}`);
      const output = `Error: [security] ${decision.reason}`;
      return { tc, output, summary, isError: true };
    }
    if (decision.action === "warn") {
      // 决策时即时警告（与压缩提示同款风格），不延迟到批量结果打印
      process.stderr.write(chalk.yellow(`[security] ${decision.reason} — allowed for ${actor.role}\n`));
    }

    // --- 第三层：before hooks（可 deny 或改写 args；管理器内部隔离抛错，此处兜底 fail-closed） ---
    const before = yield* Effect.tryPromise({
      try: () => security.hooks.runBefore({ toolName: tc.toolName, args, actor }),
      catch: (e) => new AgentError(`Before-hooks for "${tc.toolName}" failed`, e),
    }).pipe(
      Effect.catchTag("AgentError", (e) =>
        Effect.succeed({ decision: { action: "deny" as const, reason: e.message }, args }),
      ),
    );
    if (before.decision.action === "deny") {
      log.log(`[security] hook denied ${tc.toolName}: ${before.decision.reason ?? "(no reason)"}`);
      const output = `Error: [security] hook denied ${tc.toolName}: ${before.decision.reason ?? "no reason"}`;
      return { tc, output, summary, isError: true };
    }
    const effectiveArgs = before.args;

    let output = yield* Effect.tryPromise({
      try: () => tool.execute(effectiveArgs, toolCtx),
      catch: (e) => new AgentError(`Tool "${tc.toolName}" failed`, e),
    }).pipe(
      Effect.catchTag("AgentError", (e) =>
        Effect.succeed(`Error: ${e.message}`),
      ),
    );

    // --- 第三层：after hooks（观察/改写结果；失败保留原结果，不掩盖工具产出） ---
    output = yield* Effect.tryPromise({
      try: () => security.hooks.runAfter({ toolName: tc.toolName, args: effectiveArgs, actor }, output),
      catch: () => new AgentError(`After-hooks for "${tc.toolName}" failed`),
    }).pipe(
      Effect.catchTag("AgentError", () => Effect.succeed(output)),
    );

    output = registry.truncateResult(tc.toolName, output);
    log.log(`[tool-result] ${tc.toolName}:`, output);

    return { tc, output, summary, isError: output.startsWith("Error") };
  });
}
