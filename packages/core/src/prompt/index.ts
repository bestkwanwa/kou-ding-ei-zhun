export { PromptBuilder } from "./builder.js";
export type { PromptContext, PromptSegment } from "./builder.js";

export { CORE, TOOL_GUIDE, lazyTools, sessionContext, memory, memoryMaintenance } from "./segments.js";

import { PromptBuilder } from "./builder.js";
import type { PromptContext } from "./builder.js";
import { CORE, TOOL_GUIDE, lazyTools, sessionContext, memory, memoryMaintenance } from "./segments.js";

export function createSystemPromptBuilder(ctx: PromptContext): PromptBuilder {
  return new PromptBuilder(ctx)
    .add("core", CORE)
    .add("tool-guide", TOOL_GUIDE)
    .add("lazy-tools", lazyTools)
    .add("memory", memory)
    .add("memory-maintenance", memoryMaintenance)
    .add("session-context", sessionContext);
}
