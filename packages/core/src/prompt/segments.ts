import type { PromptSegment } from "./builder.js";
import { MemoryStore } from "../memory/index.js";

/** 核心身份、能力、规则、工作目录 */
export const CORE: PromptSegment = (ctx) => `You are an expert coding agent. You help users with software engineering tasks.

You can:
- Read, write, and edit files
- Execute shell commands
- Search through codebases

When making changes:
- Always read files before editing them
- Make minimal, targeted changes
- Explain your reasoning briefly
- Verify your changes work

Working directory: ${ctx.cwd}`;

/** 工具使用指引 */
export const TOOL_GUIDE: PromptSegment = `Tool usage rules:
- Always use read_file to read file contents. NEVER use run_command with cat/head/tail to read files.
- Use run_command only for: running tests, builds, git operations, installing packages, and other non-reading commands.
- Core tools are always available: read_file, write_file, edit_file, run_command, list_files, glob, grep, search_tools, memory.
- Additional tools exist but are not loaded. Use search_tools(query) to discover them by keyword.
- After search_tools returns a tool, you can call it directly in the same conversation.`;

/** 延迟加载工具列表（无 lazy 工具时返回空串） */
export const lazyTools: PromptSegment = (ctx) => {
  const summaries = ctx.registry.getLazyToolSummaries();
  if (summaries.length === 0) return "";
  const lines = summaries.map((t) => `- ${t.name} - ${t.summary}`);
  return `Additional tools (use search_tools to load their full schema):\n${lines.join("\n")}`;
};

/** Session 上下文（仅恢复会话时出现） */
export const sessionContext: PromptSegment = (ctx) => {
  if (!ctx.session) return "";
  return `This is a continued session. ${ctx.session.messageCount} previous messages were restored.\nPrevious topic: ${ctx.session.summary}`;
};

/** 项目记忆（无记忆时返回空串，段落自动消失；每次渲染从磁盘刷新） */
export const memory: PromptSegment = (ctx) => {
  try {
    return new MemoryStore(ctx.cwd).buildInjectionText();
  } catch {
    return "";
  }
};
