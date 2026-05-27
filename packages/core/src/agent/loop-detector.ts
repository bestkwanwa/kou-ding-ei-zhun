import type { ToolCallPart, ToolResultPart } from "ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterRecord {
  iteration: number;
  toolCalls: Array<{ toolName: string; argsKey: string; resultHash: string }>;
  hasTextOutput: boolean;
}

export type LoopDetectionKind =
  | "exact-repeat"
  | "alternation"
  | "endless-tools";

export interface LoopDetectionResult {
  detected: boolean;
  kind?: LoopDetectionKind;
  message?: string;
}

export interface LoopDetectorConfig {
  /** Same tool + same args + same result repeated N times → trigger (default: 3) */
  exactRepeatThreshold: number;
  /** Window size for alternation check — must see ≥ window consecutive iterations (default: 6) */
  alternationWindow: number;
  /** Consecutive iterations with tool calls but zero text output → trigger (default: 10) */
  endlessToolsThreshold: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  exactRepeatThreshold: 3,
  alternationWindow: 6,
  endlessToolsThreshold: 10,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys then stringify — produces a stable key for args. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Simple djb2 hash — fast, non-crypto, good enough for result dedup. */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Pure detection functions
// ---------------------------------------------------------------------------

/**
 * Pattern 1 — exact repeat:
 * Same tool name + same args + same result appears ≥ threshold times.
 */
export function detectExactRepeat(
  records: IterRecord[],
  threshold: number,
): LoopDetectionResult {
  if (records.length < threshold) return { detected: false };

  const windowSize = threshold * 2;
  const window = records.slice(-windowSize);
  const counts = new Map<string, { count: number; toolName: string; argsKey: string }>();

  for (const rec of window) {
    for (const tc of rec.toolCalls) {
      const fp = `${tc.toolName}\0${tc.argsKey}\0${tc.resultHash}`;
      const existing = counts.get(fp);
      if (existing) {
        existing.count++;
      } else {
        counts.set(fp, { count: 1, toolName: tc.toolName, argsKey: tc.argsKey });
      }
    }
  }

  for (const [, entry] of counts) {
    if (entry.count >= threshold) {
      return {
        detected: true,
        kind: "exact-repeat",
        message: `Tool "${entry.toolName}" called ${entry.count} times with identical args and result`,
      };
    }
  }

  return { detected: false };
}

/**
 * Pattern 2 — alternation:
 * Recent iterations show a period-2 cycle of tool-name tuples (A→B→A→B→…).
 */
export function detectAlternation(
  records: IterRecord[],
  window: number,
): LoopDetectionResult {
  if (records.length < window) return { detected: false };

  const recent = records.slice(-window);

  // Build sequence: each iteration → sorted comma-joined tool names
  const sequence = recent.map((r) =>
    r.toolCalls.map((c) => c.toolName).sort().join(","),
  );

  // Check period-2: sequence[i] === sequence[i % 2] for all i, and A ≠ B
  const a = sequence[0];
  const b = sequence[1];
  if (a !== b && sequence.every((s, i) => s === (i % 2 === 0 ? a : b))) {
    return {
      detected: true,
      kind: "alternation",
      message: `Alternating tool cycle detected: ${a} ↔ ${b} (${window} consecutive iterations)`,
    };
  }

  return { detected: false };
}

/**
 * Pattern 3 — endless tools:
 * N consecutive iterations with tool calls but no text output.
 */
export function detectEndlessTools(
  records: IterRecord[],
  threshold: number,
): LoopDetectionResult {
  let consecutive = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec.toolCalls.length > 0 && !rec.hasTextOutput) {
      consecutive++;
    } else {
      break;
    }
  }

  if (consecutive >= threshold) {
    return {
      detected: true,
      kind: "endless-tools",
      message: `${consecutive} consecutive iterations with tool calls but no text output`,
    };
  }

  return { detected: false };
}

// ---------------------------------------------------------------------------
// LoopDetector class
// ---------------------------------------------------------------------------

export class LoopDetector {
  private records: IterRecord[] = [];
  private config: LoopDetectorConfig;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Pair tool calls with their results by toolCallId and record the iteration. */
  recordIteration(
    iteration: number,
    toolCalls: ToolCallPart[],
    results: ToolResultPart[],
    hasText: boolean,
  ): void {
    // Build a result lookup by toolCallId
    const resultMap = new Map<string, string>();
    for (const r of results) {
      const value =
        typeof r.output === "object" && r.output !== null && "value" in r.output
          ? (r.output as { value: string }).value
          : String(r.output);
      resultMap.set(r.toolCallId, value);
    }

    const callRecords: IterRecord["toolCalls"] = toolCalls.map((tc) => ({
      toolName: tc.toolName,
      argsKey: stableStringify(tc.input),
      resultHash: djb2(resultMap.get(tc.toolCallId) ?? ""),
    }));

    this.records.push({
      iteration,
      toolCalls: callRecords,
      hasTextOutput: hasText,
    });
  }

  /** Run all three detectors, return first match. */
  check(): LoopDetectionResult {
    return (
      detectExactRepeat(this.records, this.config.exactRepeatThreshold) ||
      detectAlternation(this.records, this.config.alternationWindow) ||
      detectEndlessTools(this.records, this.config.endlessToolsThreshold) ||
      { detected: false }
    );
  }

  /** Clear all recorded history. */
  reset(): void {
    this.records = [];
  }

  /** Read-only access for testing. */
  getHistory(): readonly IterRecord[] {
    return this.records;
  }
}
