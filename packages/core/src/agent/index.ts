import { Effect, Console } from "effect";
import chalk from "chalk";
import * as readline from "node:readline";
import {
  streamText,
  type ToolSet,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool, ToolContext } from "../tools/types.js";
import { toAiSdkToolDefinitions } from "../llm/tool-adapter.js";

export interface AgentOptions {
  cwd: string;
  verbose: boolean;
  maxIterations?: number;
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

Working directory: `;

export class AgentError {
  readonly _tag = "AgentError";
  constructor(readonly message: string, readonly cause?: unknown) {}
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
  tools: Tool[],
  initialPrompt: string,
  options: AgentOptions
): Effect.Effect<void, AgentError> {
  const toolCtx: ToolContext = { cwd: options.cwd };
  const toolDefs: ToolSet = toAiSdkToolDefinitions(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const maxIterations = options.maxIterations ?? 50;

  // Run one round of tool-calling loop until the model stops calling tools
  const runToolLoop = (
    messages: ModelMessage[]
  ): Effect.Effect<ModelMessage[], AgentError> => {
    const loop = (state: LoopState): Effect.Effect<LoopState, AgentError> =>
      Effect.gen(function* () {
        if (state.iteration >= maxIterations) {
          yield* Console.log(chalk.yellow(`\nMax iterations (${maxIterations}) reached.`));
          return { ...state, done: true };
        }

        if (options.verbose && state.iteration > 0) {
          yield* Console.log(chalk.gray(`--- Tool iteration ${state.iteration + 1} ---`));
        }

        const result = streamText({
          model,
          system: SYSTEM_PROMPT + options.cwd,
          messages: state.messages,
          tools: toolDefs,
        });

        // Stream text to stdout
        yield* Effect.tryPromise({
          try: async () => {
            for await (const delta of result.textStream) {
              process.stdout.write(delta);
            }
          },
          catch: (e) => new AgentError("Streaming failed", e),
        });

        const { text, toolCalls } = yield* Effect.tryPromise({
          try: () => Promise.resolve(result).then(async (r) => ({
            text: await r.text,
            toolCalls: await r.toolCalls,
          })),
          catch: (e) => new AgentError("LLM response failed", e),
        });

        // No tool calls → done with this round
        if (!toolCalls || toolCalls.length === 0) {
          const finalMessages = text
            ? [...state.messages, { role: "assistant" as const, content: text }]
            : state.messages;
          return { ...state, messages: finalMessages, done: true };
        }

        if (options.verbose) {
          for (const tc of toolCalls) {
            yield* Console.log(
              chalk.blue(`\n[Tool Call] ${tc.toolName}`),
              chalk.gray(JSON.stringify(tc.input, null, 2))
            );
          }
        }

        // Execute tools
        const toolResults: ToolResultPart[] = yield* Effect.all(
          toolCalls.map((tc) =>
            Effect.gen(function* () {
              const tool = toolMap.get(tc.toolName);
              if (!tool) {
                return {
                  type: "tool-result" as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  output: { type: "text" as const, value: `Error: unknown tool "${tc.toolName}"` },
                };
              }

              const output = yield* Effect.tryPromise({
                try: () => tool.execute(tc.input as Record<string, unknown>, toolCtx),
                catch: (e) => new AgentError(`Tool "${tc.toolName}" failed`, e),
              }).pipe(
                Effect.catchTag("AgentError", (e) =>
                  Effect.succeed(`Error: ${e.message}`)
                )
              );

              if (options.verbose) {
                yield* Console.log(
                  chalk.green(`[Tool Result] ${tc.toolName}:`),
                  chalk.gray(output.length > 500 ? output.slice(0, 500) + "..." : output)
                );
              }

              return {
                type: "tool-result" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                output: { type: "text" as const, value: output },
              };
            })
          ),
          { concurrency: "unbounded" }
        );

        // Build assistant content: text + tool calls
        const assistantContent: Array<ToolCallPart | { type: "text"; text: string }> = [];
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

        return { messages: newMessages, iteration: state.iteration + 1, done: false };
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
    const userInput = createUserInput();
    let history: ModelMessage[] = [];

    // First message from initial prompt
    const firstUserMsg: ModelMessage = { role: "user", content: initialPrompt };
    history = yield* runToolLoop([firstUserMsg]);

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

      history = yield* runToolLoop([...history, { role: "user", content: trimmed }]);
    }
  });
}
