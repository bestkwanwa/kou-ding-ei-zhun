import type { ToolRegistry } from "../tools/registry.js";
import type { SkillManager } from "../skills/index.js";

export interface PromptContext {
  cwd: string;
  registry: ToolRegistry;
  /** 技能管理器：索引与已激活正文注入（省略时两段为空） */
  skills?: SkillManager;
  session?: {
    summary: string;
    messageCount: number;
  };
  /** 会话启动时一次性预计算：记忆维护周期是否到期（SessionStore.list() 全量读盘，只做一次） */
  memoryMaintenanceDue?: boolean;
}

export type PromptSegment = string | ((ctx: PromptContext) => string);

interface NamedSegment {
  name: string;
  segment: PromptSegment;
}

export class PromptBuilder {
  private segments: NamedSegment[] = [];

  constructor(private ctx: PromptContext) {}

  add(name: string, segment: PromptSegment): this {
    this.segments.push({ name, segment });
    return this;
  }

  private render(seg: PromptSegment): string {
    return typeof seg === "function" ? seg(this.ctx) : seg;
  }

  build(): string {
    return this.segments
      .map((s) => this.render(s.segment))
      .filter(Boolean)
      .join("\n\n");
  }

  debug(): string {
    const lines = this.segments.map((s) => {
      const content = this.render(s.segment);
      const on = content.length > 0;
      return `  ${s.name}: [${on ? "ON" : "OFF"}] ${content.length} chars`;
    });
    return lines.join("\n");
  }
}
