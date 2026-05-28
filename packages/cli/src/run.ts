import chalk from "chalk";
import { Effect } from "effect";
import { runAgent, createDefaultRegistry, ToolRegistry, createModelFactory, AgentError, version } from "@kda/core";
import type { AppConfig } from "@kda/core";

export interface RunOptions {
  toolsEnabled: boolean;
  verbose: boolean;
}

function printBanner(config: AppConfig) {
  console.log("");
  console.log(chalk.bold.cyan(`  kda`) + chalk.gray(` v${version}`));
  console.log(chalk.bold.cyan(`  model `) + chalk.gray(` ${config.provider}/${config.model}`));
  console.log(chalk.bold.cyan(`  cwd `) + chalk.gray(` ${config.cwd}`));
  console.log("");
}

export async function runAgentCli(
  prompt: string,
  config: AppConfig,
  opts: RunOptions
): Promise<void> {
  printBanner(config);

  const registry = opts.toolsEnabled ? createDefaultRegistry() : new ToolRegistry();
  const factory = createModelFactory(config);
  const model = factory(config.model);

  const program = runAgent(model, registry, prompt, {
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
