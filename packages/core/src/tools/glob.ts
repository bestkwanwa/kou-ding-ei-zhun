import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";
import { formatFsError } from "./errors.js";

const MAX_GLOB_RESULTS = 100;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern recursively. Supports patterns like '**/*.ts', 'src/**/*.js', '*.json'. Returns matching file paths relative to working directory.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files. Supports ** (recursive), * (any segment), ? (single char). E.g. '**/*.ts', 'src/**/*.test.js'",
      },
      path: {
        type: "string",
        description: "Base directory to search in, relative to working directory. Defaults to '.'",
      },
    },
    required: ["pattern"],
  }),
  async execute(args, ctx) {
    const basePath = path.resolve(ctx.cwd, (args.path as string) || ".");
    const pattern = args.pattern as string;
    const results: string[] = [];

    let regex: RegExp;
    try {
      regex = globToRegex(pattern);
    } catch {
      return `Error: invalid glob pattern: "${pattern}"`;
    }

    async function walk(dir: string): Promise<void> {
      if (results.length >= MAX_GLOB_RESULTS) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const rel = path.relative(basePath, fullPath);
          if (regex.test(rel)) {
            results.push(path.relative(ctx.cwd, fullPath));
            if (results.length >= MAX_GLOB_RESULTS) return;
          }
        }
      }
    }

    try {
      await walk(basePath);
    } catch (err) {
      return formatFsError(err, (args.path as string) || ".");
    }

    if (results.length === 0) return "No files matched the pattern.";
    if (results.length >= MAX_GLOB_RESULTS) {
      results.push(`... (truncated at ${MAX_GLOB_RESULTS} results)`);
    }
    return results.join("\n");
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 10_000,
  cleanable: true,
};

/**
 * Convert a glob pattern to a RegExp.
 * Supports: ** (any path), * (any non-separator), ? (single char)
 */
function globToRegex(glob: string): RegExp {
  const parts = glob.split("/");
  const regexParts = parts.map((part) => {
    if (part === "**") return "(?:.+/)?";
    return part
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  });
  // Join with / separator; ** already includes optional trailing /
  const joined = regexParts.join("/");
  return new RegExp(`^${joined}$`);
}
