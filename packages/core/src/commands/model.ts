import chalk from "chalk";
import type { Command } from "./types.js";

const USAGE = `Usage: /model [model-id]

Actions:
  (none)          Show the current model
  <model-id>      Switch the model (takes effect on the next turn)
  help            Show usage

The model id is passed to the provider as-is and is not validated offline —
a typo surfaces as an LLM error on the next turn; switch back with /model.
Resolution at startup: -m flag > DEFAULT_MODEL env > per-provider default.`;

export const modelCommand: Command = {
  name: "model",
  description: "Show or switch the current model",
  usage: "/model [model-id]",
  execute(args, ctx) {
    if (!ctx.model) return "Model switching is not available.";
    const parts = args.split(/\s+/).filter(Boolean);
    const action = parts[0];

    switch (action) {
      case undefined:
        return `Current model: ${chalk.yellow(`${ctx.model.provider}/${ctx.model.get()}`)}${chalk.gray("  (switch with /model <model-id>)")}`;

      case "help":
        return USAGE;

      default: {
        // 只允许单 token，避免误粘贴整句话
        if (parts.length > 1) return `Usage: /model [model-id]`;
        ctx.model.set(action);
        return `Model switched to ${chalk.yellow(action)} (takes effect on the next turn).`;
      }
    }
  },
};
