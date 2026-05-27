import { describe, it, expect } from "vitest";
import {
  detectExactRepeat,
  detectAlternation,
  detectEndlessTools,
  LoopDetector,
  type IterRecord,
} from "./loop-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  iteration: number,
  toolCalls: Array<{ toolName: string; argsKey: string; resultHash: string }>,
  hasText = false,
): IterRecord {
  return { iteration, toolCalls, hasTextOutput: hasText };
}

// ---------------------------------------------------------------------------
// detectExactRepeat
// ---------------------------------------------------------------------------

describe("detectExactRepeat", () => {
  it("detects same tool + args + result repeated 3 times", () => {
    const records = Array.from({ length: 3 }, (_, i) =>
      makeRecord(i, [{ toolName: "list_files", argsKey: '{"path":"."}', resultHash: "abc" }]),
    );
    const result = detectExactRepeat(records, 3);
    expect(result.detected).toBe(true);
    expect(result.kind).toBe("exact-repeat");
    expect(result.message).toContain("list_files");
  });

  it("does NOT detect when results differ (progress is being made)", () => {
    const records = Array.from({ length: 3 }, (_, i) =>
      makeRecord(i, [{ toolName: "list_files", argsKey: '{"path":"."}', resultHash: "hash" + i }]),
    );
    expect(detectExactRepeat(records, 3).detected).toBe(false);
  });

  it("does NOT detect when args differ", () => {
    const records = Array.from({ length: 3 }, (_, i) =>
      makeRecord(i, [{ toolName: "read_file", argsKey: '{"path":"' + i + '"}', resultHash: "same" }]),
    );
    expect(detectExactRepeat(records, 3).detected).toBe(false);
  });

  it("does NOT detect when below threshold", () => {
    const records = Array.from({ length: 2 }, (_, i) =>
      makeRecord(i, [{ toolName: "list_files", argsKey: '{"path":"."}', resultHash: "abc" }]),
    );
    expect(detectExactRepeat(records, 3).detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectAlternation
// ---------------------------------------------------------------------------

describe("detectAlternation", () => {
  it("detects A↔B alternating 6 iterations", () => {
    const records: IterRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord(i, [
        {
          toolName: i % 2 === 0 ? "read_file" : "search_files",
          argsKey: "k" + i,
          resultHash: "h" + i,
        },
      ]),
    );
    const result = detectAlternation(records, 6);
    expect(result.detected).toBe(true);
    expect(result.kind).toBe("alternation");
    expect(result.message).toContain("read_file");
    expect(result.message).toContain("search_files");
  });

  it("does NOT detect when below window", () => {
    const records = Array.from({ length: 4 }, (_, i) =>
      makeRecord(i, [
        { toolName: i % 2 === 0 ? "a" : "b", argsKey: "k", resultHash: "h" },
      ]),
    );
    expect(detectAlternation(records, 6).detected).toBe(false);
  });

  it("does NOT detect when pattern breaks", () => {
    const records: IterRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord(i, [
        { toolName: i % 2 === 0 ? "read_file" : "search_files", argsKey: "k", resultHash: "h" },
      ]),
    );
    // Break the pattern at the last iteration
    records[5] = makeRecord(5, [{ toolName: "edit_file", argsKey: "k", resultHash: "h" }]);
    expect(detectAlternation(records, 6).detected).toBe(false);
  });

  it("does NOT detect when all iterations use the same tool", () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      makeRecord(i, [{ toolName: "read_file", argsKey: "k", resultHash: "h" }]),
    );
    expect(detectAlternation(records, 6).detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectEndlessTools
// ---------------------------------------------------------------------------

describe("detectEndlessTools", () => {
  it("detects 10 consecutive iterations with tools but no text", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord(i, [{ toolName: "run_command", argsKey: "k", resultHash: "h" }]),
    );
    const result = detectEndlessTools(records, 10);
    expect(result.detected).toBe(true);
    expect(result.kind).toBe("endless-tools");
  });

  it("does NOT detect when some iterations have text output", () => {
    const records: IterRecord[] = Array.from({ length: 10 }, (_, i) =>
      makeRecord(i, [{ toolName: "run_command", argsKey: "k", resultHash: "h" }], i === 5),
    );
    expect(detectEndlessTools(records, 10).detected).toBe(false);
  });

  it("does NOT detect when below threshold", () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      makeRecord(i, [{ toolName: "run_command", argsKey: "k", resultHash: "h" }]),
    );
    expect(detectEndlessTools(records, 10).detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LoopDetector class
// ---------------------------------------------------------------------------

describe("LoopDetector", () => {
  it("detects exact repeat via recordIteration + check", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 3; i++) {
      detector.recordIteration(
        i,
        [{ type: "tool-call", toolCallId: "c" + i, toolName: "list_files", input: { path: "." } }],
        [{ type: "tool-result", toolCallId: "c" + i, toolName: "list_files", output: { type: "text", value: "same output" } }],
        false,
      );
    }
    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.kind).toBe("exact-repeat");
  });

  it("resets history correctly", () => {
    const detector = new LoopDetector();
    detector.recordIteration(
      0,
      [{ type: "tool-call", toolCallId: "c0", toolName: "list_files", input: {} }],
      [{ type: "tool-result", toolCallId: "c0", toolName: "list_files", output: { type: "text", value: "x" } }],
      false,
    );
    expect(detector.getHistory().length).toBe(1);
    detector.reset();
    expect(detector.getHistory().length).toBe(0);
  });
});
