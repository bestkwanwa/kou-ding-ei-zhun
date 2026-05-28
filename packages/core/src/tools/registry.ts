import { tool as aiTool, type ToolSet } from "ai";
import type { Tool } from "./types.js";
import { DEFAULT_MAX_RESULT_LENGTH } from "./types.js";

/**
 * 工具注册中心：统一管理工具的注册、查找、AI SDK 对接。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private _parallelizableNames: Set<string> | null = null;

  /** 注册单个工具 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this._parallelizableNames = null; // invalidate cache
  }

  /** 批量注册 */
  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  /** 按名称查找 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 所有已注册工具 */
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** 转换为 AI SDK ToolSet（仅 schema，不含 execute） */
  toAiSdkDefinitions(): ToolSet {
    const result: ToolSet = {};
    for (const t of this.tools.values()) {
      result[t.name] = aiTool({
        description: t.description,
        inputSchema: t.parameters,
      } as any) as ToolSet[string];
    }
    return result;
  }

  /** 获取所有可并行工具名（缓存） */
  getParallelizableToolNames(): Set<string> {
    if (!this._parallelizableNames) {
      this._parallelizableNames = new Set(
        [...this.tools.values()]
          .filter((t) => t.parallelizable)
          .map((t) => t.name),
      );
    }
    return this._parallelizableNames;
  }

  /** 截断工具结果到最大长度 */
  truncateResult(toolName: string, output: string): string {
    const tool = this.tools.get(toolName);
    const maxLen = tool?.maxResultLength ?? DEFAULT_MAX_RESULT_LENGTH;
    if (output.length <= maxLen) return output;
    return output.slice(0, maxLen) + `\n...[truncated, ${output.length} chars total]`;
  }

  /** 已注册工具数量 */
  get size(): number {
    return this.tools.size;
  }
}
