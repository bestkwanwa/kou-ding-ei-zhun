import { tool as aiTool, type ToolSet } from "ai";
import type { Tool } from "./types.js";
import { DEFAULT_MAX_RESULT_LENGTH } from "./types.js";

/**
 * 工具注册中心：统一管理工具的注册、查找、AI SDK 对接。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private _parallelizableNames: Set<string> | null = null;
  /** 已发现的 lazy 工具名称 */
  private discovered = new Set<string>();

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

  /** 转换为 AI SDK ToolSet（核心工具 + 已发现的 lazy 工具） */
  toAiSdkDefinitions(): ToolSet {
    const result: ToolSet = {};
    for (const t of this.tools.values()) {
      if (t.lazy && !this.discovered.has(t.name)) continue;
      result[t.name] = aiTool({
        description: t.description,
        inputSchema: t.parameters,
      } as any) as ToolSet[string];
    }
    return result;
  }

  /** 获取延迟工具的名称列表 */
  getLazyToolNames(): string[] {
    return [...this.tools.values()]
      .filter((t) => t.lazy)
      .map((t) => t.name);
  }

  /** 获取延迟工具的摘要列表（name + description 第一句） */
  getLazyToolSummaries(): Array<{ name: string; summary: string }> {
    return [...this.tools.values()]
      .filter((t) => t.lazy)
      .map((t) => ({ name: t.name, summary: t.description.split(".")[0] }));
  }

  /** 标记一个 lazy 工具为已发现 */
  discover(name: string): void {
    const t = this.tools.get(name);
    if (t?.lazy) {
      this.discovered.add(name);
      this._parallelizableNames = null;
    }
  }

  /** 将已发现的 lazy 工具 schema 同步到 toolDefs */
  syncDiscovered(toolDefs: ToolSet): void {
    for (const name of this.discovered) {
      if (toolDefs[name]) continue; // already present
      const t = this.tools.get(name);
      if (!t) continue;
      toolDefs[name] = aiTool({
        description: t.description,
        inputSchema: t.parameters,
      } as any) as ToolSet[string];
    }
  }

  /** 搜索延迟工具，在 name/description/hint 中模糊匹配关键词 */
  searchTools(query: string): Tool[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.tools.values()].filter((t) => {
      if (!t.lazy) return false;
      const text = `${t.name} ${t.description} ${t.hint ?? ""}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });
  }

  /** 计算工具 schema 的字符总量 */
  private calcSchemaSize(tools: Tool[]): number {
    return tools.reduce((sum, t) => {
      return sum + JSON.stringify({
        name: t.name,
        description: t.description,
        inputSchema: (t.parameters as any).schema ?? t.parameters,
      }).length;
    }, 0);
  }

  /** 获取延迟加载统计 */
  getToolStats(): {
    total: number;
    active: number;
    inactive: number;
    activeChars: number;
    inactiveChars: number;
  } {
    const all = [...this.tools.values()];
    const active = all.filter((t) => !t.lazy || this.discovered.has(t.name));
    const inactive = all.filter((t) => t.lazy && !this.discovered.has(t.name));
    return {
      total: all.length,
      active: active.length,
      inactive: inactive.length,
      activeChars: this.calcSchemaSize(active),
      inactiveChars: this.calcSchemaSize(inactive),
    };
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

  /** 截断工具结果到最大长度，使用 Head/Tail 60/40 分割 */
  truncateResult(toolName: string, output: string): string {
    const tool = this.tools.get(toolName);
    const maxLen = tool?.maxResultLength ?? DEFAULT_MAX_RESULT_LENGTH;
    if (output.length <= maxLen) return output;
    const headLen = Math.floor(maxLen * 0.6);
    const tailLen = maxLen - headLen;
    const omitted = output.length - maxLen;
    const divider = `─── ...${omitted} chars omitted... ───`;
    return (
      output.slice(0, headLen) + `\n${divider}\n` + output.slice(-tailLen)
    );
  }

  /** 已注册工具数量 */
  get size(): number {
    return this.tools.size;
  }
}
