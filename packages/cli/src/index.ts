#!/usr/bin/env node

import { program } from "commander";
import { runAgentCli } from "./run.js";
import { loadConfig, version } from "@kda/core";

program
  .name("kda")
  .description("A coding agent CLI with multi-model support")
  .version(version);

program
  .argument("[prompt]", "The task or question for the agent (optional)")
  .option("-m, --model <model>", "Model to use (e.g. gpt-4o, claude-sonnet-4-20250514)")
  .option("-p, --provider <provider>", "LLM provider: openai | anthropic")
  .option("--cwd <dir>", "Working directory", process.cwd())
  .option("--no-tools", "Disable tool use (chat only mode)")
  .option("-v, --verbose", "Show verbose output including tool calls")
  .action(async (prompt, opts) => {
    const config = loadConfig({
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
    });
    await runAgentCli(prompt ?? "", config, {
      toolsEnabled: opts.tools,
      verbose: opts.verbose,
    });
  });

program.parse();
