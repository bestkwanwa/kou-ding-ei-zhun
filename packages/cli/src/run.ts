import chalk from "chalk";
import { Effect } from "effect";
import * as readline from "node:readline";
import { runAgent, createDefaultRegistry, ToolRegistry, createModelFactory, AgentError, SessionStore, MemoryStore, SkillManager, PluginManager, createDefaultChannelGateway, version, DEFAULT_COMMANDS } from "@kda/core";
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
  const memCount = new MemoryStore(config.cwd).loadAll().length;
  console.log(chalk.bold.cyan(`  mem `) + chalk.gray(`  ${memCount} memories loaded (use /memory)`));
  const skillCount = new SkillManager(config.cwd).list().length;
  if (skillCount > 0) {
    console.log(chalk.bold.cyan(`  skills`) + chalk.gray(`  ${skillCount} available (use /skill or /<skill-name>)`));
  }
  if (DEFAULT_COMMANDS.length > 0) {
    const guide = DEFAULT_COMMANDS.map((c) => `${c.usage}  ${c.description}`).join("\n         ");
    console.log(chalk.bold.cyan(`  cmds `) + chalk.gray(` ${guide}`));
  }
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

  const registry = opts.toolsEnabled ? createDefaultRegistry(config.cwd) : new ToolRegistry();
  const factory = createModelFactory(config);
  const model = factory(config.model);

  // Plugin 加载必须先于 runAgent：toolDefs 在 agent 启动时快照，晚注册的工具 LLM 不可见
  const plugins = new PluginManager(config.cwd);
  if (opts.toolsEnabled) {
    await plugins.loadAll(registry);
    const loaded = plugins.list().filter((p) => p.status === "enabled").length;
    if (loaded > 0) {
      console.log(chalk.bold.cyan(`  plugins`) + chalk.gray(`  ${loaded} loaded (use /plugin)`));
    }
  }

  // Channel gateway 必须先于 runAgent 创建：agent 循环的输入多路复用器启动时即接入 gateway 入站队列
  const channels = createDefaultChannelGateway(config.cwd);

  const program = runAgent(model, registry, prompt, {
    cwd: config.cwd,
    verbose: opts.verbose,
    session,
    plugins,
    channels,
  });

  // dispose 只能走 finally：process.exit 会跳过它（Ctrl+C 被 readline raw mode 吞掉，无 SIGINT 可挂）
  let exitCode = 0;
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
    exitCode = 1;
  } finally {
    // 先关 channel：open http server 会挂住事件循环，不关进程退不出去
    await channels.stopAll();
    await plugins.disposeAll();
  }
  if (exitCode !== 0) process.exit(exitCode);
}
