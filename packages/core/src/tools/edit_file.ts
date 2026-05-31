import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";
import { formatFsError } from "./errors.js";

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace a specific string in a file. Use this for targeted edits. The old_string must match exactly.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit, relative to the working directory",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace",
      },
      new_string: {
        type: "string",
        description: "The string to replace it with",
      },
    },
    required: ["path", "old_string", "new_string"],
  }),
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path as string);
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return formatFsError(err, args.path as string);
    }

    if (!content.includes(oldStr)) {
      return `Error: old_string not found in ${args.path}`;
    }

    const count = content.split(oldStr).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times in ${args.path}. Provide more context to make it unique.`;
    }

    try {
      const updated = content.replace(oldStr, newStr);
      await fs.writeFile(filePath, updated, "utf-8");
      return `File edited: ${args.path}`;
    } catch (err) {
      return formatFsError(err, args.path as string);
    }
  },
  maxResultLength: 1_000,
};
