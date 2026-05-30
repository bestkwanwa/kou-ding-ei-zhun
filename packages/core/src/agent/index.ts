import { Effect, Console } from "effect";
import chalk from "chalk";
import * as readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  streamText,
  type ToolSet,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { withRetry } from "../llm/retry.js";
import { LoopDetector, type LoopDetectorConfig } from "./loop-detector.js";
import { TokenBudgetDetector, type TokenBudgetConfig } from "./token-budget.js";

// Debug logger — writes to .kda-debug.log in cwd
function createLogger(cwd: string) {
  const logPath = resolve(cwd, ".kda-debug.log");
  const ts = () => new Date().toISOString();
  return {
    log(...args: unknown[]) {
      const line = `[${ts()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ")}\n`;
      appendFileSync(logPath, line, "utf-8");
    },
    clear() {
      writeFileSync(logPath, `[${ts()}] === kda debug log started ===\n`, "utf-8");
    },
  };
}

export interface AgentOptions {
  cwd: string;
  verbose: boolean;
  maxIterations?: number;
  loopDetector?: Partial<LoopDetectorConfig>;
  tokenBudget?: Partial<TokenBudgetConfig>;
}

export const SYSTEM_PROMPT = `You are an expert coding agent. You help users with software engineering tasks.

You can:
- Read, write, and edit files
- Execute shell commands
- Search through codebases

When making changes:
- Always read files before editing them
- Make minimal, targeted changes
- Explain your reasoning briefly
- Verify your changes work

Tool usage rules:
- Always use read_file to read file contents. NEVER use run_command with cat/head/tail to read files.
- Use run_command only for: running tests, builds, git operations, installing packages, and other non-reading commands.

Working directory: `;

export class AgentError {
  readonly _tag = "AgentError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

interface LoopState {
  messages: ModelMessage[];
  iteration: number;
  done: boolean;
}

function createUserInput(): {
  read: (prompt: string) => Effect.Effect<string, AgentError>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    read(prompt: string) {
      return Effect.async((resume) => {
        rl.question(prompt, (answer) => {
          resume(Effect.succeed(answer));
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

export function runAgent(
  model: LanguageModelV3,
  registry: ToolRegistry,
  initialPrompt: string,
  options: AgentOptions,
): Effect.Effect<void, AgentError> {
  const toolCtx: ToolContext = { cwd: options.cwd };
  const toolDefs: ToolSet = registry.toAiSdkDefinitions();
  const parallelizableNames = registry.getParallelizableToolNames();
  const maxIterations = options.maxIterations ?? 50;
  const log = createLogger(options.cwd);
  const detector = new LoopDetector(options.loopDetector);
  const tokenBudget = new TokenBudgetDetector(options.tokenBudget);

  // Run one round of tool-calling loop until the model stops calling tools
  const runToolLoop = (
    messages: ModelMessage[],
  ): Effect.Effect<ModelMessage[], AgentError> => {
    const loop = (state: LoopState): Effect.Effect<LoopState, AgentError> =>
      Effect.gen(function* () {
        log.log(`[loop] iteration=${state.iteration}, messages=${state.messages.length}`);

        if (state.iteration >= maxIterations) {
          log.log(`[loop] max iterations reached`);
          return { ...state, done: true };
        }

        // Log request: what we send to the model
        log.log(`[request] system prompt length=${(SYSTEM_PROMPT + options.cwd).length}`);
        log.log(`[request] tools:`, Object.keys(toolDefs).map((name) => ({ name, tool: toolDefs[name] })));
        log.log(`[request] messages:`, state.messages);

        // Process fullStream events
        const { text, toolCalls } = yield* withRetry(
          Effect.tryPromise({
            try: async () => {
              const result = streamText({
                model,
                system: SYSTEM_PROMPT + options.cwd,
                messages: state.messages,
                tools: toolDefs,
                maxRetries: 0, // retry 完全由 Effect 管理，不让 AI SDK 自行重试
              });

              let collectedText = "";
              const collectedToolCalls: ToolCallPart[] = [];
              for await (const event of result.fullStream) {
              switch (event.type) {
                // --- Text ---
                case "text-delta":
                  process.stdout.write(event.text);
                  collectedText += event.text;
                  break;
                case "text-start":
                case "text-end":
                  break;

                // --- Reasoning ---
                case "reasoning-delta":
                  if (options.verbose) process.stderr.write(event.text);
                  break;
                case "reasoning-start":
                case "reasoning-end":
                  break;

                // --- Tool input streaming ---
                case "tool-input-start":
                  if (options.verbose) console.log(chalk.blue(`\n[tool-input-start] ${event.toolName}`));
                  break;
                case "tool-input-delta":
                  break;
                case "tool-input-end":
                  break;

                // --- Tool call ---
                case "tool-call":
                  collectedToolCalls.push({
                    type: "tool-call",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.input,
                  });
                  break;

                // --- Tool result/error (only when execute is defined) ---
                case "tool-result":
                case "tool-error":
                case "tool-output-denied":
                  break;

                // --- Sources & Files ---
                case "source":
                case "file":
                  break;

                // --- Step lifecycle ---
                case "start":
                case "start-step":
                  break;
                case "finish-step":
                  tokenBudget.recordUsage(event.usage);
                  {
                    const u = tokenBudget.getAccumulated();
                    const step = event.usage;
                    const inTok = step.inputTokens ?? 0;
                    const outTok = step.outputTokens ?? 0;
                    const budget = tokenBudget.check().budget;
                    process.stderr.write(chalk.gray(`\n[Tokens: ${u}/${budget} (+${inTok}↑ ${outTok}↓)]\n`));
                  }
                  if (options.verbose) {
                    console.log(chalk.gray(`[finish-step] reason=${event.finishReason}`));
                  }
                  break;
                case "finish":
                  break;
                case "abort":
                  log.log(`[abort]`, event.reason);
                  break;

                // --- Error ---
                case "error":
                  log.log(`[stream-error]`, event.error);
                  break;

                default:
                  log.log(`[stream-unknown]`, event);
                  break;
              }
            }
            return { text: collectedText, toolCalls: collectedToolCalls };
          },
          catch: (e) => new AgentError("LLM streaming failed", e),
          }),
          log,
        );

        // Log response: what the model returned
        log.log(`[response] text length=${text.length}, toolCalls=${toolCalls.length}`);
        log.log(`[response] text:`, text);
        log.log(`[response] toolCalls:`, toolCalls);

        // No tool calls → done with this round
        if (!toolCalls || toolCalls.length === 0) {
          log.log(`[loop] no tool calls, done`);
          const finalMessages = text
            ? [...state.messages, { role: "assistant" as const, content: text }]
            : state.messages;

          return { ...state, messages: finalMessages, done: true };
        }

        for (const tc of toolCalls) {
          log.log(`[tool-call] ${tc.toolName}`, tc.input);
        }

        // Execute tools — 不直接输出，执行完后统一按顺序打印
        const executeTool = (tc: ToolCallPart) =>
          Effect.gen(function* () {
            const tool = registry.get(tc.toolName);
            if (!tool) {
              log.log(`[tool-error] unknown tool: ${tc.toolName}`);
              const output = `Error: unknown tool "${tc.toolName}"`;
              return { tc, output, summary: "", isError: true };
            }

            const args = tc.input as Record<string, unknown>;
            const summary = [args.path, args.command, args.pattern].find((v) => typeof v === "string") ?? "";

            let output = yield* Effect.tryPromise({
              try: () =>
                tool.execute(tc.input as Record<string, unknown>, toolCtx),
              catch: (e) => new AgentError(`Tool "${tc.toolName}" failed`, e),
            }).pipe(
              Effect.catchTag("AgentError", (e) =>
                Effect.succeed(`Error: ${e.message}`),
              ),
            );

            output = registry.truncateResult(tc.toolName, output);
            log.log(`[tool-result] ${tc.toolName}:`, output);

            return { tc, output, summary, isError: output.startsWith("Error") };
          });

        // 分组执行：可并行的工具无限制并发，不可并行的串行
        const parallelCalls = toolCalls.filter((tc) => parallelizableNames.has(tc.toolName));
        const serialCalls = toolCalls.filter((tc) => !parallelizableNames.has(tc.toolName));

        log.log(`[exec] ${parallelCalls.length} parallel, ${serialCalls.length} serial`);

        const [parallelResults, serialResults] = yield* Effect.all([
          Effect.all(parallelCalls.map(executeTool), { concurrency: "unbounded" }),
          Effect.all(serialCalls.map(executeTool), { concurrency: 1 }),
        ], { concurrency: 2 });

        // 按原始 toolCalls 顺序输出结果
        const resultMap = new Map<string, { tc: ToolCallPart; output: string; summary: string; isError: boolean }>();
        for (const r of [...parallelResults, ...serialResults]) {
          resultMap.set(r.tc.toolCallId, r);
        }
        for (const tc of toolCalls) {
          const r = resultMap.get(tc.toolCallId)!;
          const tag = r.isError ? chalk.red(" ✗") : chalk.green(` ✓ ${r.output.length}c`);
          process.stderr.write(chalk.blue(`  ↳ ${tc.toolName}${r.summary ? `(${r.summary})` : ""}${tag}\n${chalk.gray(r.output)}\n`));
        }

        const toolResults: ToolResultPart[] = [...parallelResults, ...serialResults].map((r) => ({
          type: "tool-result" as const,
          toolCallId: r.tc.toolCallId,
          toolName: r.tc.toolName,
          output: { type: "text" as const, value: r.output },
        }));

        // Build assistant content: text + tool calls
        const assistantContent: Array<
          ToolCallPart | { type: "text"; text: string }
        > = [];
        if (text) {
          assistantContent.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          assistantContent.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
        }

        const newMessages: ModelMessage[] = [
          ...state.messages,
          { role: "assistant", content: assistantContent },
          { role: "tool", content: toolResults },
        ];

        // Loop detection
        detector.recordIteration(state.iteration, toolCalls, toolResults, text.length > 0);
        const loopResult = detector.check();
        if (loopResult.detected) {
          log.log(`[loop-detector] ${loopResult.kind}: ${loopResult.message}`);
          console.log(chalk.yellow(`\n[Loop detected: ${loopResult.message}]`));
          return { messages: newMessages, iteration: state.iteration + 1, done: true };
        }

        // Token budget check
        const budgetResult = tokenBudget.check();
        if (budgetResult.exceeded) {
          log.log(`[token-budget] exceeded: ${budgetResult.message}`);
          console.log(chalk.yellow(`\n[Token budget exceeded: ${budgetResult.message}]`));
          return { messages: newMessages, iteration: state.iteration + 1, done: true };
        }

        log.log(`[loop] tools executed, messages=${newMessages.length}, next iteration=${state.iteration + 1}`);

        return {
          messages: newMessages,
          iteration: state.iteration + 1,
          done: false,
        };
      });

    return Effect.gen(function* () {
      let state: LoopState = { messages, iteration: 0, done: false };
      while (!state.done) {
        state = yield* loop(state);
      }
      return state.messages;
    });
  };

  // Main conversation loop: tool loop → read input → repeat
  return Effect.gen(function* () {
    log.clear();
    const userInput = createUserInput();
    let history: ModelMessage[] = [];

    // First message from initial prompt (skip if empty → go straight to interactive)
    if (initialPrompt.trim()) {
      const firstUserMsg: ModelMessage = { role: "user", content: initialPrompt };
      log.log(`[conv] first prompt:`, initialPrompt);
      history = yield* runToolLoop([firstUserMsg]);
      log.log(`[conv] first turn done, history=${history.length} messages`);
    } else {
      log.log(`[conv] no initial prompt, entering interactive mode`);
    }

    // Continuous conversation
    while (true) {
      console.log(""); // blank line
      const input = yield* userInput.read(chalk.cyan("> "));
      const trimmed = input.trim();

      if (!trimmed) {
        yield* Console.log(chalk.gray("Bye!"));
        userInput.close();
        return;
      }

      log.log(`[conv] user input:`, trimmed);
      log.log(`[conv] passing history=${history.length} messages`);
      history = yield* runToolLoop([
        ...history,
        { role: "user", content: trimmed },
      ]);
      log.log(`[conv] turn done, history=${history.length} messages`);
    }
  });
}
