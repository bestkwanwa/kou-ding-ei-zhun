import { exec } from "node:child_process";
import { promisify } from "node:util";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

const MAX_GREP_LINES = 100;

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search for a pattern in file contents using grep. Returns matching file paths, line numbers, and matching lines. Faster and more capable than search_files.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The text or regex pattern to search for",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in, relative to working directory. Defaults to '.'",
      },
      include: {
        type: "string",
        description:
          "File glob to include (e.g. '*.ts', '*.py'). Only searches matching files.",
      },
    },
    required: ["pattern"],
  }),
  async execute(args, ctx) {
    const searchPath = (args.path as string) || ".";
    const pattern = args.pattern as string;
    const include = args.include as string | undefined;

    // Build grep command
    // -r: recursive, -n: line numbers, -I: skip binary files
    // --include: file pattern filter
    const parts = ["grep", "-rnI"];
    if (include) {
      parts.push(`--include=${include}`);
    }
    // Escape pattern for shell
    parts.push(shellesc(pattern), "--", shellesc(searchPath));

    const cmd = parts.join(" ");

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: ctx.cwd,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      // Limit output lines
      const lines = stdout.split("\n").slice(0, MAX_GREP_LINES);
      if (lines.length < stdout.split("\n").length - 1) {
        lines.push(`... (truncated)`);
      }
      return lines.join("\n") || "No matches found.";
    } catch (err: unknown) {
      const e = err as { code?: string; killed?: boolean; message?: string };
      // grep exits with code 1 when no matches — that's not an error
      if (e.code === "1") {
        return "No matches found.";
      }
      if (e.killed) {
        return `Error: grep timed out after 15s. Try narrowing the search path or using a more specific pattern.`;
      }
      if (e.message?.includes("ENOENT")) {
        return `Error: grep command not found. Is grep installed on this system?`;
      }
      return `Error running grep: ${e.message ?? `exit code ${e.code}`}. Try checking the pattern and path.`;
    }
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 10_000,
  cleanable: true,
};

/** Minimal shell escaping for safety */
function shellesc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
