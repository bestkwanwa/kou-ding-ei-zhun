import chalk from "chalk";
import { Agent } from "../agent/index.js";
import { allTools } from "../tools/index.js";
import { createModelFactory } from "../llm/index.js";
import type { AppConfig } from "../config/index.js";

export interface RunOptions {
  toolsEnabled: boolean;
  verbose: boolean;
}

export async function runAgent(
  prompt: string,
  config: AppConfig,
  opts: RunOptions
): Promise<void> {
  const tools = opts.toolsEnabled ? allTools : [];
  const factory = createModelFactory(config);
  const model = factory(config.model);

  const agent = new Agent(model, tools, {
    cwd: config.cwd,
    verbose: opts.verbose,
  });

  try {
    await agent.run(prompt);
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.red(`Error: ${err.message}`));
    } else {
      console.error(chalk.red("An unknown error occurred"));
    }
    process.exit(1);
  }
}
