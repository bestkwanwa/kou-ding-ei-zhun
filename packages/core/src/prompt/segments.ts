import type { PromptSegment } from "./builder.js";
import { MemoryStore } from "../memory/index.js";
import { readLastMaintenanceAt, maintenancePending } from "../memory/maintenance.js";

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
- Core tools are always available: read_file, write_file, edit_file, run_command, list_files, glob, grep, search_tools, memory, ingest_docs, search_knowledge.
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

/** 维护指令正文（嵌入上次整理时间与当前时间） */
function buildMaintenanceDirective(cwd: string): string {
  const last = readLastMaintenanceAt(cwd);
  return [
    `## Memory Maintenance Due (5+ new sessions and more than 24h since the last pass; last run: ${last ?? "never"}; current time: ${new Date().toISOString()})`,
    "",
    "Run a full maintenance pass over the memory library, in these phases:",
    "",
    "**Phase 1: Locate** — Scan the whole library with memory lint (the report already includes content previews and the issue list — no need to read memories one by one).",
    "**Phase 2: Tidy** — Act directly on the lint report:",
    "  - Broken paths and long-unused: memory delete (pass the filename) to remove them",
    "  - Duplicate names: memory save the merged version (same name auto-overwrites), then delete the extras",
    "  - Still valid but inaccurate descriptions: memory save to overwrite and update",
    "**Phase 3: Report** — Summarize what this pass did in one paragraph.",
    "**Phase 4: Record** — Save the Phase 3 summary as the maintenance record via memory save (type=dynamic, slug=memory-maintenance); the next trigger time is based on this record's write time.",
    "",
    "Note: read and delete take the filename (e.g. resource-deploy-process.md), not the name.",
  ].join("\n");
}

/**
 * 记忆维护指令（触发判定与整理决策分离：代码只判定注入时机，整理由模型用 memory 工具完成）。
 * 闸门 1：会话启动冻结的到期判定；闸门 2：每轮廉价复查磁盘标记，模型记完账指令即消失。
 */
export const memoryMaintenance: PromptSegment = (ctx) => {
  if (!ctx.memoryMaintenanceDue) return "";
  if (!maintenancePending(ctx.cwd)) return "";
  try {
    return buildMaintenanceDirective(ctx.cwd);
  } catch {
    return "";
  }
};
