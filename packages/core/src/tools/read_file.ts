import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns the file content as a string.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read, relative to the working directory",
      },
    },
    required: ["path"],
  }),
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path as string);
    const content = await fs.readFile(filePath, "utf-8");
    return content;
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 50_000,
};
