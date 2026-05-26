import type { Schema } from "ai";

export interface ToolContext {
  cwd: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Schema<unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
