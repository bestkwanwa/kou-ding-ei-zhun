import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { APICallError } from "ai";
import { isRetryableError, withRetry } from "./retry.js";
import { AgentError } from "../agent/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAPIError(statusCode: number, isRetryable = false) {
  return new AgentError(
    "LLM streaming failed",
    new APICallError({
      message: `HTTP ${statusCode}`,
      url: "test",
      requestBodyValues: {},
      statusCode,
      responseBody: "",
      isRetryable,
    }),
  );
}

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  const retryableCases = [
    { label: "429 Too Many Requests", statusCode: 429 },
    { label: "503 Service Unavailable", statusCode: 503 },
    { label: "502 Bad Gateway", statusCode: 502 },
    { label: "408 Request Timeout", statusCode: 408 },
    { label: "500 Internal Server Error", statusCode: 500 },
    { label: "504 Gateway Timeout", statusCode: 504 },
  ];

  for (const { label, statusCode } of retryableCases) {
    it(`${label} → retryable`, () => {
      expect(isRetryableError(makeAPIError(statusCode))).toBe(true);
    });
  }

  const nonRetryableCases = [
    { label: "401 Unauthorized", statusCode: 401 },
    { label: "400 Bad Request", statusCode: 400 },
    { label: "403 Forbidden", statusCode: 403 },
    { label: "404 Not Found", statusCode: 404 },
  ];

  for (const { label, statusCode } of nonRetryableCases) {
    it(`${label} → NOT retryable`, () => {
      expect(isRetryableError(makeAPIError(statusCode))).toBe(false);
    });
  }

  it("APICallError with isRetryable=true → retryable", () => {
    expect(isRetryableError(makeAPIError(418, true))).toBe(true);
  });

  it("plain AgentError without cause → NOT retryable", () => {
    expect(isRetryableError(new AgentError("no cause"))).toBe(false);
  });

  it("AgentError with non-API cause → NOT retryable", () => {
    expect(isRetryableError(new AgentError("fail", new Error("random")))).toBe(false);
  });

  it("non-AgentError value → NOT retryable", () => {
    expect(isRetryableError(new Error("plain"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const effect = Effect.succeed("ok");
    const log = { log: vi.fn() };
    const result = await Effect.runPromise(withRetry(effect, log));
    expect(result).toBe("ok");
    expect(log.log).not.toHaveBeenCalled();
  });

  it("retries retryable errors and succeeds", async () => {
    let attempt = 0;
    const log = { log: vi.fn() };

    const effect = Effect.gen(function* () {
      attempt++;
      if (attempt <= 2) {
        yield* Effect.fail(makeAPIError(429));
      }
      return "recovered";
    });

    const result = await Effect.runPromise(withRetry(effect, log));
    expect(result).toBe("recovered");
    expect(attempt).toBe(3);
    expect(log.log).toHaveBeenCalledTimes(2);
  });

  it("fails immediately for non-retryable error (no retry)", async () => {
    let attempt = 0;
    const log = { log: vi.fn() };

    const effect = Effect.gen(function* () {
      attempt++;
      yield* Effect.fail(makeAPIError(401));
    });

    try {
      await Effect.runPromise(withRetry(effect, log));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(attempt).toBe(1);
      expect(log.log).not.toHaveBeenCalled();
    }
  });
});
