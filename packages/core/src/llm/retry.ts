import { Effect, Schedule } from "effect";
import { APICallError } from "ai";
import type { AgentError } from "../agent/index.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function isRetryableError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as AgentError)._tag === "AgentError"
  ) {
    const cause = (error as AgentError).cause;
    if (cause instanceof APICallError) {
      // TODO: 补充更多 retryable status code，遇到实际错误时逐步完善
      const s = cause.statusCode;
      if (cause.isRetryable) return true;
      if (s === undefined) return false;
      // 408 Request Timeout
      // 429 Too Many Requests
      // 500 Internal Server Error
      // 502 Bad Gateway
      // 503 Service Unavailable
      // 504 Gateway Timeout
      return s === 408 || s === 429 || (s >= 500 && s <= 504);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retry schedule: exponential backoff + jitter, max 3 retries
// ---------------------------------------------------------------------------

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(3)),
  Schedule.whileInput(isRetryableError),
);

// ---------------------------------------------------------------------------
// withRetry wrapper
// ---------------------------------------------------------------------------

export function withRetry<A>(
  effect: Effect.Effect<A, AgentError>,
  log: { log: (...args: unknown[]) => void },
): Effect.Effect<A, AgentError> {
  return effect.pipe(
    Effect.tapError((err) => {
      if (isRetryableError(err)) {
        log.log(`[retry] retryable error, will retry: ${err.message}`, err.cause);
      }
      return Effect.void;
    }),
    Effect.retry(retrySchedule),
  );
}
