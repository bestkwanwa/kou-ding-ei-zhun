import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search for a text pattern in files. Returns matching file paths and lines.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The text or regex pattern to search for",
      },
      directory: {
        type: "string",
        description: "Directory to search in, relative to working directory. Defaults to '.'",
      },
      file_pattern: {
        type: "string",
        description: "Glob pattern to filter files (e.g. '*.ts'). Defaults to all files.",
      },
    },
    required: ["pattern"],
  }),
  async execute(args, ctx) {
    const dirPath = path.resolve(ctx.cwd, (args.directory as string) || ".");
    const pattern = new RegExp(args.pattern as string, "i");
    const filePattern = args.file_pattern as string | undefined;
    const results: string[] = [];
    const maxResults = 50;

    async function walk(dir: string): Promise<void> {
      if (results.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (filePattern && !fullPath.match(globToRegex(filePattern))) continue;
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                const rel = path.relative(ctx.cwd, fullPath);
                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= maxResults) return;
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }

    await walk(dirPath);
    return results.join("\n") || "No matches found.";
  },
};

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped + "$");
}
