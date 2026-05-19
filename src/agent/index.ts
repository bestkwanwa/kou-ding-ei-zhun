import chalk from "chalk";
import type { Tool } from "../tools/types.js";

export interface AgentOptions {
  cwd: string;
  verbose: boolean;
  maxIterations?: number;
}

const SYSTEM_PROMPT = `You are an expert coding agent. You help users with software engineering tasks.

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

export class Agent {
  private tools: Tool[];
  private options: AgentOptions;

  constructor(_provider: unknown, tools: Tool[], options: AgentOptions) {
    this.tools = tools;
    this.options = options;
  }

  async run(_prompt: string): Promise<void> {
    // TODO: replace loop body with Effect + Stream for:
    //   - LLM call (via Vercel AI SDK streamText)
    //   - tool execution pipeline
    //   - result accumulation and message history update
    console.log(chalk.yellow("Agent loop not yet implemented."));
  }
}
