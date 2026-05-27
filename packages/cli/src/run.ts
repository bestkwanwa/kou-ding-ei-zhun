import chalk from "chalk";
import { Effect } from "effect";
import { runAgent, allTools, createModelFactory, AgentError, version } from "@kda/core";
import type { AppConfig } from "@kda/core";

export interface RunOptions {
  toolsEnabled: boolean;
  verbose: boolean;
}

function printBanner(config: AppConfig) {
  console.log(chalk.bold.cyan(`  kda`) + chalk.gray(` v${version}`));
  console.log(chalk.gray(`  model: ${config.provider}/${config.model}`));
  console.log(chalk.gray(`  cwd:   ${config.cwd}`));
  console.log("");
}

export async function runAgentCli(
  prompt: string,
  config: AppConfig,
  opts: RunOptions
): Promise<void> {
  printBanner(config);

  const tools = opts.toolsEnabled ? allTools : [];
  const factory = createModelFactory(config);
  const model = factory(config.model);

  const program = runAgent(model, tools, prompt, {
    cwd: config.cwd,
    verbose: opts.verbose,
  });

  try {
    await Effect.runPromise(program);
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(chalk.red(`Error: ${err.message}`));
    } else if (err instanceof Error) {
      console.error(chalk.red(`Error: ${err.message}`));
    } else {
      console.error(chalk.red("An unknown error occurred"));
    }
    process.exit(1);
  }
}
