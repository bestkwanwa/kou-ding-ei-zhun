import chalk from "chalk";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool } from "../tools/types.js";

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

export class Agent {
  private model: LanguageModelV3;
  private tools: Tool[];
  private options: AgentOptions;

  constructor(model: LanguageModelV3, tools: Tool[], options: AgentOptions) {
    this.model = model;
    this.tools = tools;
    this.options = options;
  }

  async run(_prompt: string): Promise<void> {
    // TODO: implement agent loop with Effect + Stream
    // this.model is ready for use with AI SDK streamText/generateText
    console.log(chalk.yellow("Agent loop not yet implemented."));
  }
}
