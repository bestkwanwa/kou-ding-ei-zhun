import type { Schema } from "ai";

export interface ToolContext {
  cwd: string;
}

/** 工具结果默认最大长度 */
export const DEFAULT_MAX_RESULT_LENGTH = 10_000;

export interface Tool {
  name: string;
  description: string;
  parameters: Schema<unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;

  /** 是否只读（无副作用），默认 false */
  readOnly?: boolean;
  /** 是否可安全并行执行，默认 false */
  parallelizable?: boolean;
  /** 工具结果最大长度（字符数），超出截断，默认 10000 */
  maxResultLength?: number;
}
