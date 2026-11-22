import { Effect, Console } from "effect";
import chalk from "chalk";
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
import { SessionStore, type SessionData } from "../session/index.js";
import { SkillManager } from "../skills/index.js";
import type { PluginManager } from "../plugins/index.js";
import { createSystemPromptBuilder } from "../prompt/index.js";
import { cleanupToolResults, DEFAULT_KEEP_TOOL_RESULT_ROUNDS, compressMessages } from "../context/index.js";
import { createDefaultCommandDispatcher } from "../commands/index.js";
import { shouldRunMaintenance } from "../memory/maintenance.js";
import { createLogger } from "../utils/logger.js";
import type { ChannelGateway, InboundMessage } from "../channels/index.js";
import { createAgentInput } from "./input.js";
import { extractReply } from "./reply.js";

export interface AgentOptions {
  cwd: string;
  verbose: boolean;
  maxIterations?: number;
  loopDetector?: Partial<LoopDetectorConfig>;
  tokenBudget?: Partial<TokenBudgetConfig>;
  session?: SessionData;
  keepToolResultRounds?: number;
  /** Plugin 管理器（/plugin 命令依赖；由 CLI 层加载完成后再传入） */
  plugins?: PluginManager;
  /** Channel 网关（/channel 命令与渠道消息处理依赖；由 CLI 层创建后传入，退出时 finally stopAll） */
  channels?: ChannelGateway;
}

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

export function runAgent(
  model: LanguageModelV3,
  registry: ToolRegistry,
  initialPrompt: string,
  options: AgentOptions,
): Effect.Effect<void, AgentError> {
  const toolCtx: ToolContext = { cwd: options.cwd };

  // Restore discovered tools from session before building toolDefs
  if (options.session) {
    for (const name of options.session.discoveredTools) {
      registry.discover(name);
    }
  }

  const toolDefs: ToolSet = registry.toAiSdkDefinitions();
  const parallelizableNames = registry.getParallelizableToolNames();
  const maxIterations = options.maxIterations ?? 50;
  const log = createLogger(options.cwd);
  const detector = new LoopDetector(options.loopDetector);
  const tokenBudget = new TokenBudgetDetector(options.tokenBudget);
  const keepToolResultRounds = options.keepToolResultRounds ?? DEFAULT_KEEP_TOOL_RESULT_ROUNDS;

  // Session context for prompt (set when session is restored)
  let sessionCtx: { summary: string; messageCount: number } | undefined;

  // Session store for persistence
  const sessionStore = new SessionStore(options.cwd);

  // 技能管理器：dispatcher（/skill 与 /<skill-name> 快捷执行）与 prompt 渲染共用同一实例
  const skills = new SkillManager(options.cwd);
  if (options.session) {
    for (const slug of options.session.loadedSkills) {
      skills.load(slug); // skill 目录已删则 resolve 失败，静默跳过
    }
  }

  // 记忆维护触发判定：整个 runAgent 只算一次（SessionStore.list() 全量读盘，绝不进每轮 prompt 渲染）
  const memoryMaintenanceDue = shouldRunMaintenance(options.cwd, sessionStore.list());

  // Run one round of tool-calling loop until the model stops calling tools
  const runToolLoop = (
    messages: ModelMessage[],
  ): Effect.Effect<ModelMessage[], AgentError> => {
    let compressed = false;
    let compressAttempts = 0;
    const MAX_COMPRESS_ATTEMPTS = 3;
    const loop = (state: LoopState): Effect.Effect<LoopState, AgentError> =>
      Effect.gen(function* () {
        log.log(`[loop] iteration=${state.iteration}, messages=${state.messages.length}`);

        if (state.iteration >= maxIterations) {
          log.log(`[loop] max iterations reached`);
          return { ...state, done: true };
        }

        // Pre-call budget check: stop before calling LLM if already exceeded
        const preCheck = tokenBudget.check();
        if (preCheck.exceeded) {
          log.log(`[token-budget] already exceeded, stopping before LLM call`);
          console.log(chalk.yellow(`\n[Token budget exceeded: ${preCheck.message}]`));
          return { messages: state.messages, iteration: state.iteration, done: true };
        }

        // Compression: when accumulated tokens reach 80% of budget, summarize all messages
        if (!compressed && compressAttempts < MAX_COMPRESS_ATTEMPTS && tokenBudget.shouldCompress()) {
          compressAttempts++;
          log.log(`[summarizer] threshold reached (accumulated=${tokenBudget.getAccumulated()}), compressing...`);
          const compressResult = yield* Effect.tryPromise({
            try: () => compressMessages(state.messages, model),
            catch: (e) => new AgentError("Compression failed", e),
          }).pipe(
            Effect.catchTag("AgentError", (e) => {
              log.log(`[summarizer] failed: ${e.message}`);
              return Effect.succeed(null);
            }),
          );
          if (compressResult) {
            log.log(`[summarizer] compressed ${compressResult.compressedCount} messages into ${compressResult.summary.length}c summary`);
            process.stderr.write(chalk.yellow(`\n[Context compressed: ${compressResult.compressedCount} messages → summary]\n`));
            state = { ...state, messages: compressResult.messages };
            compressed = true;
            tokenBudget.reset();
          }
        }

        // Log request: what we send to the model
        const promptBuilder = createSystemPromptBuilder({
          cwd: options.cwd,
          registry,
          skills,
          session: sessionCtx,
          memoryMaintenanceDue,
        });
        const systemPrompt = promptBuilder.build();
        log.log(`[prompt-segments]`, promptBuilder.debug());

        // Context management: clean old tool results
        const { messages: cleanedMessages, cleanedCount, savedChars } = cleanupToolResults(
          state.messages, registry, keepToolResultRounds,
        );
        if (cleanedCount > 0) {
          const estToken = (chars: number) => Math.round(chars / 4);
          log.log(`[context-manager] cleaned ${cleanedCount} results, saved ~${estToken(savedChars)} tokens (${savedChars} chars, kept ${keepToolResultRounds} recent rounds)`);
        }

        const stats = registry.getToolStats();
        const estToken = (chars: number) => Math.round(chars / 4);
        log.log(`[tool-stats] total=${stats.total} | active=${stats.active} (~${estToken(stats.activeChars)} tokens) | inactive=${stats.inactive} (~${estToken(stats.inactiveChars)} tokens saved)`);
        log.log(`[request] system prompt:\n${systemPrompt}`);
        log.log(`[request] tools:`, JSON.stringify(toolDefs, null, 2));
        log.log(`[request] messages:`, cleanedMessages);

        // Process fullStream events
        const { text, toolCalls } = yield* withRetry(
          Effect.tryPromise({
            try: async () => {
              const result = streamText({
                model,
                system: systemPrompt,
                messages: cleanedMessages,
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
                    log.log(`[token-usage] accumulated=${u} budget=${budget} input=${inTok} output=${outTok}`);
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

        // Sync discovered lazy tools into toolDefs for next LLM request
        registry.syncDiscovered(toolDefs);
        log.log(`[lazy-load] toolDefs now:`, Object.keys(toolDefs));
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

  // Slash command dispatcher ("/" 前缀输入在此拦截，不进 LLM；/<skill-name> 快捷执行返回转发文本)
  const dispatcher = createDefaultCommandDispatcher({ cwd: options.cwd, skills, plugins: options.plugins, channels: options.channels });

  // Main conversation loop: tool loop → read input → repeat
  return Effect.gen(function* () {
    log.clear();
    // 统一输入源：终端行与渠道消息进同一 FIFO，单消费者串行处理（见 input.ts）
    const input = createAgentInput(options.channels);

    // Initialize session state
    let sessionId: string;
    let sessionCreatedAt: string;
    let sessionSummary: string;
    let history: ModelMessage[];

    if (options.session) {
      sessionId = options.session.id;
      sessionCreatedAt = options.session.createdAt;
      sessionSummary = options.session.summary;
      history = options.session.messages;
      sessionCtx = { summary: sessionSummary, messageCount: history.length };
      log.log(`[session] resumed id=${sessionId}, messages=${history.length}, discovered=${options.session.discoveredTools.length}`);
      // Visible feedback: show what was restored
      if (history.length > 0) {
        process.stderr.write(chalk.gray(`  ↳ Restored ${history.length} messages from session ${sessionId}\n`));
        process.stderr.write(chalk.gray(`  ↳ Topic: ${sessionSummary}\n`));
        // Print a compact preview of the conversation
        for (const msg of history) {
          if (msg.role === "user" && typeof msg.content === "string") {
            process.stderr.write(chalk.gray(`    [user] ${msg.content.slice(0, 100)}\n`));
          }
        }
      }
    } else {
      const newSession = sessionStore.create(initialPrompt);
      sessionId = newSession.id;
      sessionCreatedAt = newSession.createdAt;
      sessionSummary = newSession.summary;
      history = [];
      log.log(`[session] new id=${sessionId}`);
    }

    const saveSession = () => {
      sessionStore.save({
        id: sessionId,
        createdAt: sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        summary: sessionSummary,
        messages: history,
        discoveredTools: registry.getDiscoveredTools(),
        loadedSkills: skills.getLoadedSkills(),
      });
    };

    // First message from initial prompt (skip if empty → go straight to interactive)
    if (initialPrompt.trim()) {
      log.log(`[conv] first prompt:`, initialPrompt);
      history = yield* runToolLoop([
        ...history,
        { role: "user" as const, content: initialPrompt },
      ]);
      log.log(`[conv] first turn done, history=${history.length} messages`);
      saveSession();
    } else {
      log.log(`[conv] no initial prompt, entering interactive mode`);
    }

    // 渠道回复：唯一出站路径经 gateway.reply → channel.send；gateway 隔离错误，永不 reject
    const gateway = options.channels;
    const sendToChannel = (text: string, msg: InboundMessage) =>
      Effect.promise(() => gateway!.reply(text, msg));

    // Continuous conversation: terminal lines and channel messages share one FIFO
    while (true) {
      console.log(""); // blank line
      input.prompt();
      const event = yield* Effect.tryPromise({
        try: () => input.next(),
        catch: (e) => new AgentError("Failed to read input", e),
      });

      let llmInput: string;
      // 本轮的"待回信"：终端轮次为 undefined（回复已流式进终端）；渠道轮次 = 触发本轮的入站消息对象，
      // LLM 期间攥着它，轮次结束时照它回信（channel 名路由回去、id 供页面对应气泡）
      let replyTo: InboundMessage | undefined;

      if (event.type === "terminal") {
        const trimmed = event.line.trim();

        if (!trimmed) {
          yield* Console.log(chalk.gray("Bye!"));
          input.close();
          return;
        }

        // 斜杠命令：handled = 已处理跳过本轮；forward = 命令产生的 LLM 转发输入（/<skill-name> 快捷执行）
        const loadedSnapshot = skills.getLoadedSkills().join("\n");
        const result = dispatcher.dispatch(trimmed);
        if (result.kind === "handled") {
          if (result.output) console.log(result.output);
          // /skill load|unload 改变了激活集 → 立即持久化（命令本身不触发 saveSession）
          if (skills.getLoadedSkills().join("\n") !== loadedSnapshot) saveSession();
          continue;
        }
        llmInput = result.kind === "forward" ? result.text : trimmed;
      } else {
        // 渠道轮次：与终端同一套分发语义（对称）；命令输出回发渠道
        replyTo = event.message;
        process.stderr.write(chalk.magenta(`[channel:${replyTo.channel}] ${chalk.bold(replyTo.sender)}: ${replyTo.text}\n`));
        const result = dispatcher.dispatch(replyTo.text);
        if (result.kind === "handled") {
          // 命令输出即最终回信，当场结清：continue 跳过 LLM 轮与末尾的统一回信
          if (result.output) {
            console.log(chalk.gray(result.output));
            yield* sendToChannel(result.output, replyTo);
          }
          continue; // "" = 静默成功，不回发
        }
        // forward 当场只发回执（"Skill activated."）；skill 执行结果由本轮 LLM 产出，末尾统一回信
        if (result.kind === "forward") yield* sendToChannel(result.notice, replyTo);
        llmInput = result.kind === "forward" ? result.text : replyTo.text;
      }

      const prevLen = history.length;
      log.log(`[conv] ${replyTo ? `channel:${replyTo.channel} input` : "user input"}:`, llmInput);
      log.log(`[conv] passing history=${history.length} messages`);
      history = yield* runToolLoop([
        ...history,
        { role: "user", content: llmInput },
      ]);
      log.log(`[conv] turn done, history=${history.length} messages`);
      saveSession();

      // 统一回信：凡进了 LLM 的渠道轮次（not-command / forward），最终回复都在此发出。
      // extractReply 以 prevLen 为下界只取本轮新增的 assistant 文本——早停轮次（预算耗尽/循环检测）
      // 本轮无产出时不越过下界捞旧轮回复重发
      if (replyTo) {
        yield* sendToChannel(extractReply(prevLen, history), replyTo);
      }
    }
  });
}
