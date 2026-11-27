import { describe, it, expect } from "vitest";
import { parseCronExpr, nextRunAfter, parseDuration, parseTimeArg } from "./parser.js";
import type { CronSchedule } from "./types.js";

// 本地时钟构造（与被测实现一致，测试不依赖时区）
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s, 0);

/** 解析 cron 表达式并包装为完整 CronSchedule（解析失败直接抛错） */
function cronSched(expr: string): CronSchedule {
  const fields = parseCronExpr(expr);
  if (typeof fields === "string") throw new Error(`bad expr in fixture: ${expr}`);
  return { type: "cron", ...fields };
}

describe("parseCronExpr", () => {
  it("parses simple values and wildcards", () => {
    expect(parseCronExpr("0 9 * * *")).toEqual({
      minute: [0], hour: [9], dom: null, month: null, dow: null,
    });
  });

  it("parses steps, ranges and lists", () => {
    expect(parseCronExpr("*/15 * * * *")).toMatchObject({ minute: [0, 15, 30, 45] });
    expect(parseCronExpr("1-5/2 * * * *")).toMatchObject({ minute: [1, 3, 5] });
    expect(parseCronExpr("5,30 * * * *")).toMatchObject({ minute: [5, 30] });
    expect(parseCronExpr("0 0 1,15 * 1-5")).toMatchObject({ dom: [1, 15], dow: [1, 2, 3, 4, 5] });
  });

  it("normalizes dow 7 to 0 (sunday)", () => {
    expect(parseCronExpr("0 0 * * 7")).toMatchObject({ dow: [0] });
    expect(parseCronExpr("0 0 * * 0,7")).toMatchObject({ dow: [0] });
  });

  it("applies vixie semantics to single-value-with-step (N/S = N..max)", () => {
    expect(parseCronExpr("20/15 * * * *")).toMatchObject({ minute: [20, 35, 50] });
  });

  it("rejects wrong field count, syntax, ranges", () => {
    expect(typeof parseCronExpr("* * * *")).toBe("string");
    expect(typeof parseCronExpr("* * * * * *")).toBe("string");
    expect(typeof parseCronExpr("a * * * *")).toBe("string");
    expect(typeof parseCronExpr("60 * * * *")).toBe("string");
    expect(typeof parseCronExpr("* 24 * * *")).toBe("string");
    expect(typeof parseCronExpr("* * 0 * *")).toBe("string");
    expect(typeof parseCronExpr("5-2 * * * *")).toBe("string");
    expect(typeof parseCronExpr("*/0 * * * *")).toBe("string");
  });
});

describe("nextRunAfter", () => {
  it("interval: returns from + ms", () => {
    const from = local(2026, 11, 26, 10, 0);
    expect(nextRunAfter({ type: "interval", ms: 90_000 }, from)?.getTime()).toBe(from.getTime() + 90_000);
  });

  it("once: future runAt passes, past runAt never fires again", () => {
    const from = local(2026, 11, 26, 10, 0);
    const future = { type: "once", runAt: local(2026, 11, 27, 9, 0).getTime() } as CronSchedule;
    expect(nextRunAfter(future, from)?.getTime()).toBe(future.runAt);
    const past = { type: "once", runAt: from.getTime() - 1000 } as CronSchedule;
    expect(nextRunAfter(past, from)).toBeNull();
  });

  it("cron: fires on the next matching minute boundary", () => {
    const sched = cronSched("*/15 * * * *");
    const next = nextRunAfter(sched, local(2026, 11, 26, 10, 7));
    expect(next?.getHours()).toBe(10);
    expect(next?.getMinutes()).toBe(15);
    expect(next?.getSeconds()).toBe(0);
  });

  it("cron: rolls to next day when today's slot passed", () => {
    const sched = cronSched("0 9 * * *");
    const next = nextRunAfter(sched, local(2026, 11, 26, 10, 0));
    expect(next?.getDate()).toBe(27);
    expect(next?.getHours()).toBe(9);
  });

  it("cron: strictly after from (the firing minute itself is not re-matched)", () => {
    const sched = cronSched("0 9 * * *");
    const at = local(2026, 11, 26, 9, 0, 30); // 9:00 已过 30 秒
    const next = nextRunAfter(sched, at);
    expect(next?.getDate()).toBe(27);
  });

  it("cron: vixie OR when both dom and dow are restricted", () => {
    // dom=1 或周一：2026-11-01 是周日，from 取 11-01 00:00 之后 → 最近的是周一 11-02
    const sched = cronSched("0 0 1 * 1");
    const next = nextRunAfter(sched, local(2026, 11, 1, 0, 0));
    expect(next?.getDate()).toBe(2);
    expect(next?.getDay()).toBe(1);
  });

  it("cron: AND when only dom restricted", () => {
    const sched = cronSched("0 0 1 * *");
    const next = nextRunAfter(sched, local(2026, 11, 5));
    expect(next?.getMonth()).toBe(11); // 12 月
    expect(next?.getDate()).toBe(1);
  });

  it("cron: returns null when no match within a year", () => {
    const sched = cronSched("0 0 30 2 *"); // 2 月 30 日不存在
    expect(nextRunAfter(sched, local(2026, 11, 26))).toBeNull();
  });
});

describe("parseDuration", () => {
  it("parses simple and compound durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("rejects invalid input", () => {
    expect(typeof parseDuration("1x")).toBe("string");
    expect(typeof parseDuration("0s")).toBe("string");
    expect(typeof parseDuration("m5")).toBe("string");
    expect(typeof parseDuration("5 m")).toBe("string");
    expect(typeof parseDuration("0.5s")).toBe("string"); // 低于最小间隔
  });
});

describe("parseTimeArg", () => {
  const now = local(2026, 11, 26, 14, 0);

  it("bare HH:mm today when future, rolls to tomorrow when passed", () => {
    expect(parseTimeArg("18:30", now)).toBe(local(2026, 11, 26, 18, 30).getTime());
    expect(parseTimeArg("09:00", now)).toBe(local(2026, 11, 27, 9, 0).getTime());
  });

  it("accepts date with T or space separator", () => {
    expect(parseTimeArg("2026-11-28T09:00", now)).toBe(local(2026, 11, 28, 9, 0).getTime());
    expect(parseTimeArg("2026-11-28 09:00", now)).toBe(local(2026, 11, 28, 9, 0).getTime());
  });

  it("rejects invalid dates and formats", () => {
    expect(typeof parseTimeArg("2026-02-30 09:00", now)).toBe("string");
    expect(typeof parseTimeArg("25:00", now)).toBe("string");
    expect(typeof parseTimeArg("next tuesday", now)).toBe("string");
  });
});
