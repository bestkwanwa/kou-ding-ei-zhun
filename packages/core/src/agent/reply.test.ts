import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { extractReply } from "./reply.js";

describe("extractReply", () => {
  it("returns the final assistant text message within the turn range", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "new answer" },
    ];
    expect(extractReply(2, messages)).toBe("new answer");
  });

  it("never crosses the fromIndex boundary (stale replies are not re-sent)", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "old answer" },
      { role: "user", content: "q" },
    ];
    expect(extractReply(1, messages)).toBe("(no reply)");
  });

  it("joins text parts of array content and skips tool-call-only messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q" },
      // 工具调用轮：assistant 数组 content 无 text part
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "read_file", args: { path: "x" } }],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read_file", output: "ok" }] },
      // 最终轮：数组 content 含 text parts
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one. " },
          { type: "text", text: "part two." },
        ],
      },
    ];
    expect(extractReply(1, messages)).toBe("part one. part two.");
  });

  it("returns the last text-bearing message when several assistant texts exist in range", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "mid answer" },
      { role: "assistant", content: "final answer" },
    ];
    expect(extractReply(1, messages)).toBe("final answer");
  });

  it("trims surrounding whitespace and treats empty text as absent", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "  spaced  " },
    ];
    expect(extractReply(1, messages)).toBe("spaced");

    const empty: ModelMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "   " },
    ];
    expect(extractReply(1, empty)).toBe("(no reply)");
  });
});
