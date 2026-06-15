import chalk from "chalk";
import { Effect } from "effect";
import * as readline from "node:readline";
import { runAgent, createDefaultRegistry, ToolRegistry, createModelFactory, AgentError, SessionStore, version } from "@kda/core";
import type { AppConfig, SessionData } from "@kda/core";

export interface RunOptions {
  toolsEnabled: boolean;
  verbose: boolean;
  continueSession?: boolean;
  resumeId?: string;
  listSessions?: boolean;
}

function printBanner(config: AppConfig) {
  console.log("");
  console.log(chalk.bold.cyan(`  kda`) + chalk.gray(` v${version}`));
  console.log(chalk.bold.cyan(`  model `) + chalk.gray(` ${config.provider}/${config.model}`));
  console.log(chalk.bold.cyan(`  cwd `) + chalk.gray(` ${config.cwd}`));
  console.log("");
}

async function pickSessionInteractive(store: SessionStore): Promise<SessionData | undefined> {
  const sessions = store.list();
  if (sessions.length === 0) {
    console.log(chalk.gray("No sessions found. Starting new."));
    return undefined;
  }

  console.log(chalk.bold.cyan("\n  Sessions:"));
  sessions.forEach((s, i) => {
    const date = s.updatedAt.slice(0, 16).replace("T", " ");
    console.log(
      chalk.gray(`  [${i + 1}]`) +
      chalk.yellow(` ${s.id}`) +
      chalk.gray(`  ${date}  (${s.messageCount} msgs)`) +
      `\n      ${s.summary}`,
    );
  });
  console.log(chalk.gray(`  [n]`) + chalk.green(` New session`));
  console.log("");

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.cyan("Select session (number or n): "), (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "n" || trimmed === "") {
        resolve(undefined);
        return;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        console.log(chalk.gray("Invalid choice. Starting new."));
        resolve(undefined);
        return;
      }
      const session = store.load(sessions[idx].id);
      resolve(session ?? undefined);
    });
  });
}

export async function runAgentCli(
  prompt: string,
  config: AppConfig,
  opts: RunOptions
): Promise<void> {
  printBanner(config);

  // Resolve session
  const sessionStore = new SessionStore(config.cwd);
  let session: SessionData | undefined;

  if (opts.resumeId) {
    session = sessionStore.load(opts.resumeId) ?? undefined;
    if (!session) {
      console.error(chalk.red(`Session ${opts.resumeId} not found.`));
      process.exit(1);
    }
  } else if (opts.continueSession) {
    const latest = sessionStore.latest();
    if (!latest) {
      console.log(chalk.yellow("No previous session found. Starting new."));
    } else {
      session = sessionStore.load(latest.id) ?? undefined;
    }
  } else if (opts.listSessions) {
    session = await pickSessionInteractive(sessionStore);
  }

  if (session) {
    console.log(chalk.gray(`  session `) + chalk.yellow(session.id) + chalk.gray(` (${session.messages.length} messages, "${session.summary}")`));
    console.log("");
  }

  const registry = opts.toolsEnabled ? createDefaultRegistry() : new ToolRegistry();
  const factory = createModelFactory(config);
  const model = factory(config.model);

  const program = runAgent(model, registry, prompt, {
    cwd: config.cwd,
    verbose: opts.verbose,
    session,
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
