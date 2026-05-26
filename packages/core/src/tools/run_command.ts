import { exec } from "node:child_process";
import { promisify } from "node:util";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Execute a shell command and return its output. Use for running tests, builds, git commands, etc.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  }),
  async execute(args, ctx) {
    const timeout = (args.timeout as number) ?? 30_000;
    try {
      const { stdout, stderr } = await execAsync(args.command as string, {
        cwd: ctx.cwd,
        timeout,
        maxBuffer: 1024 * 1024,
      });
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      return parts.join("\n") || "(no output)";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const parts: string[] = [`Exit code: non-zero`];
      if (e.stdout) parts.push(e.stdout);
      if (e.stderr) parts.push(`[stderr]\n${e.stderr}`);
      if (e.message) parts.push(e.message);
      return parts.join("\n");
    }
  },
};
