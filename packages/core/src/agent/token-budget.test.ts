import { describe, it, expect } from "vitest";
import { TokenBudgetDetector, DEFAULT_MAX_TOTAL_TOKENS } from "./token-budget.js";
import type { LanguageModelUsage } from "ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(totalTokens: number | undefined): LanguageModelUsage {
  return {
    inputTokens: totalTokens !== undefined ? Math.floor(totalTokens / 2) : undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: totalTokens !== undefined ? Math.ceil(totalTokens / 2) : undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// TokenBudgetDetector
// ---------------------------------------------------------------------------

describe("TokenBudgetDetector", () => {
  it("accumulates totalTokens from recordUsage", () => {
    const detector = new TokenBudgetDetector();
    detector.recordUsage(makeUsage(100));
    detector.recordUsage(makeUsage(200));
    expect(detector.getAccumulated()).toBe(300);
  });

  it("check() returns exceeded=true when over budget", () => {
    const detector = new TokenBudgetDetector({ maxTotalTokens: 500 });
    detector.recordUsage(makeUsage(300));
    detector.recordUsage(makeUsage(250));
    const result = detector.check();
    expect(result.exceeded).toBe(true);
    expect(result.usage).toBe(550);
    expect(result.budget).toBe(500);
    expect(result.message).toContain("550");
    expect(result.message).toContain("500");
  });

  it("check() returns exceeded=false when under budget", () => {
    const detector = new TokenBudgetDetector();
    detector.recordUsage(makeUsage(100));
    const result = detector.check();
    expect(result.exceeded).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it("check() returns exceeded=true when exactly at budget", () => {
    const detector = new TokenBudgetDetector({ maxTotalTokens: 500 });
    detector.recordUsage(makeUsage(500));
    const result = detector.check();
    expect(result.exceeded).toBe(true);
  });

  it("handles undefined totalTokens as 0", () => {
    const detector = new TokenBudgetDetector();
    detector.recordUsage(makeUsage(undefined));
    detector.recordUsage(makeUsage(100));
    expect(detector.getAccumulated()).toBe(100);
  });

  it("reset() clears accumulated tokens and lastStep", () => {
    const detector = new TokenBudgetDetector();
    detector.recordUsage(makeUsage(500));
    expect(detector.getAccumulated()).toBe(500);
    expect(detector.getLastStep()).not.toBeNull();
    detector.reset();
    expect(detector.getAccumulated()).toBe(0);
    expect(detector.getLastStep()).toBeNull();
  });

  it("defaults to 100k budget", () => {
    const detector = new TokenBudgetDetector();
    expect(detector.check().budget).toBe(DEFAULT_MAX_TOTAL_TOKENS);
    expect(DEFAULT_MAX_TOTAL_TOKENS).toBe(100_000);
  });

  it("getLastStep() returns last recorded usage", () => {
    const detector = new TokenBudgetDetector();
    detector.recordUsage(makeUsage(100));
    detector.recordUsage(makeUsage(200));
    expect(detector.getLastStep()?.totalTokens).toBe(200);
  });
});
