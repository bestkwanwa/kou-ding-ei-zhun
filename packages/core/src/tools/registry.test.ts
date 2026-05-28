import { describe, it, expect } from "vitest";
import { jsonSchema } from "ai";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: `Test tool: ${overrides.name}`,
    parameters: jsonSchema({ type: "object", properties: {} }),
    async execute() {
      return "ok";
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  it("register + get", () => {
    const registry = new ToolRegistry();
    const tool = makeTool({ name: "foo" });
    registry.register(tool);
    expect(registry.get("foo")).toBe(tool);
    expect(registry.get("bar")).toBeUndefined();
  });

  it("registerAll + getAll", () => {
    const registry = new ToolRegistry();
    const tools = [makeTool({ name: "a" }), makeTool({ name: "b" })];
    registry.registerAll(tools);
    expect(registry.size).toBe(2);
    expect(registry.getAll()).toHaveLength(2);
  });

  it("register overwrites existing tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "a", description: "v1" }));
    registry.register(makeTool({ name: "a", description: "v2" }));
    expect(registry.size).toBe(1);
    expect(registry.get("a")!.description).toBe("v2");
  });

  it("toAiSdkDefinitions returns ToolSet with correct keys", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file" }));
    registry.register(makeTool({ name: "write_file" }));
    const defs = registry.toAiSdkDefinitions();
    expect(Object.keys(defs)).toEqual(["read_file", "write_file"]);
  });

  it("getParallelizableToolNames returns only parallelizable tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "read_file", parallelizable: true, readOnly: true }));
    registry.register(makeTool({ name: "write_file", parallelizable: false }));
    registry.register(makeTool({ name: "list_files", parallelizable: true, readOnly: true }));
    const names = registry.getParallelizableToolNames();
    expect(names).toEqual(new Set(["read_file", "list_files"]));
  });

  it("getParallelizableToolNames caches result", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "a", parallelizable: true }));
    const first = registry.getParallelizableToolNames();
    const second = registry.getParallelizableToolNames();
    expect(first).toBe(second); // same reference
  });

  it("getParallelizableToolNames invalidated after new register", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "a", parallelizable: true }));
    const first = registry.getParallelizableToolNames();
    registry.register(makeTool({ name: "b", parallelizable: true }));
    const second = registry.getParallelizableToolNames();
    expect(first).not.toBe(second);
    expect(second).toEqual(new Set(["a", "b"]));
  });

  it("truncateResult respects tool maxResultLength", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "short", maxResultLength: 10 }));
    const longOutput = "a".repeat(100);
    expect(registry.truncateResult("short", longOutput)).toBe(
      "a".repeat(10) + `\n...[truncated, 100 chars total]`,
    );
  });

  it("truncateResult uses default when tool has no maxResultLength", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "default" }));
    const short = "hello";
    expect(registry.truncateResult("default", short)).toBe(short);
  });

  it("truncateResult does not truncate when within limit", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "ok", maxResultLength: 100 }));
    expect(registry.truncateResult("ok", "short")).toBe("short");
  });

  it("truncateResult for unknown tool uses default limit", () => {
    const registry = new ToolRegistry();
    const longOutput = "x".repeat(20_000);
    const result = registry.truncateResult("unknown", longOutput);
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("truncated");
  });
});
