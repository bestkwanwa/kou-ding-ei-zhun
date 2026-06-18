import type { LanguageModelUsage } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

export interface TokenBudgetConfig {
  /** 最大 total token 上限（整个会话累计），默认 100k */
  maxTotalTokens: number;
}

export interface TokenBudgetResult {
  exceeded: boolean;
  usage: number;
  budget: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// TokenBudgetDetector
// ---------------------------------------------------------------------------

export class TokenBudgetDetector {
  private accumulated = 0;
  private lastStep: LanguageModelUsage | null = null;
  private maxTotalTokens: number;

  constructor(config?: Partial<TokenBudgetConfig>) {
    this.maxTotalTokens = config?.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  }

  /** 接收 finish-step 事件的 usage，累加 totalTokens */
  recordUsage(usage: LanguageModelUsage): void {
    this.lastStep = usage;
    this.accumulated += usage.totalTokens ?? 0;
  }

  /** 检查是否超预算 */
  check(): TokenBudgetResult {
    const exceeded = this.accumulated >= this.maxTotalTokens;
    return {
      exceeded,
      usage: this.accumulated,
      budget: this.maxTotalTokens,
      message: exceeded
        ? `Token budget exceeded: ${this.accumulated} / ${this.maxTotalTokens}`
        : undefined,
    };
  }

  /** 当前累计量 */
  getAccumulated(): number {
    return this.accumulated;
  }

  /**
   * 是否需要压缩：基于累计 token（与 budget stop 一致）。
   * 压缩成功后 agent 会 reset()，不会重复触发。
   */
  shouldCompress(threshold = 0.8): boolean {
    return this.accumulated >= this.maxTotalTokens * threshold;
  }

  /** 上一步的 usage（用于 TUI 展示） */
  getLastStep(): LanguageModelUsage | null {
    return this.lastStep;
  }

  /** 清零 */
  reset(): void {
    this.accumulated = 0;
    this.lastStep = null;
  }
}
