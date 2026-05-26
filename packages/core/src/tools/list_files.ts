import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories at the given path. Returns names with file type indicators.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list, relative to working directory. Defaults to '.'",
      },
    },
  }),
  async execute(args, ctx) {
    const dirPath = path.resolve(ctx.cwd, (args.path as string) || ".");
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return lines.join("\n") || "(empty directory)";
  },
};
