import chalk from "chalk";
import { Agent, allTools, createModelFactory } from "@kda/core";
import type { AppConfig } from "@kda/core";

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
