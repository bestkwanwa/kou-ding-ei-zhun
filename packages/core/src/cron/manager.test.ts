import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronManager } from "./manager.js";
import type { CronTrigger } from "./types.js";

// --- Helpers ---

let dir: string;
let warnSpy: MockInstance;

/** 可推进的假时钟（本地时区无关：全部用相对毫秒推进） */
function makeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
      return new Date(t);
    },
  };
}

function makeManager(clock: ReturnType<typeof makeClock>): CronManager {
  return new CronManager(dir, { now: clock.now });
}

function addIntervalTask(mgr: CronManager, ms: number, payload = "echo hi", name?: string) {
  return mgr.addTask({
    name,
    kind: "bash",
    schedule: { type: "interval", ms },
    scheduleExpr: `every ${ms}ms`,
    payload,
  });
}

/** 收集 onDue 事件的 sink */
function collect(mgr: CronManager): CronTrigger[] {
  const fired: CronTrigger[] = [];
  mgr.setOnDue((t) => fired.push(t));
  return fired;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kda-cron-"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

// --- 持久化 ---

describe("CronManager persistence", () => {
  it("tasks and runs survive restart (new instance reads same file)", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const added = addIntervalTask(mgr, 60_000, "echo hi", "ticker");
    expect(added).toMatchObject({ task: { name: "ticker", status: "active" } });

    const reopened = makeManager(clock);
    expect(reopened.listTasks()).toHaveLength(1);
    expect(reopened.listTasks()[0].name).toBe("ticker");
  });

  it("starts empty on missing file and warns once on corrupt JSON", () => {
    mkdirSync(join(dir, ".kda"), { recursive: true });
    writeFileSync(join(dir, ".kda", "cron.json"), "{ not json", "utf-8");
    const mgr = makeManager(makeClock());
    expect(mgr.listTasks()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("rejects empty payload, too-small interval, past once time, duplicate name", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    expect(typeof mgr.addTask({ kind: "prompt", schedule: { type: "interval", ms: 60_000 }, scheduleExpr: "e", payload: "  " })).toBe("string");
    expect(typeof addIntervalTask(mgr, 500)).toBe("string");
    expect(typeof mgr.addTask({ kind: "prompt", schedule: { type: "once", runAt: clock.now().getTime() - 1 }, scheduleExpr: "at", payload: "x" })).toBe("string");
    addIntervalTask(mgr, 60_000, "a", "dup");
    expect(typeof addIntervalTask(mgr, 90_000, "b", "dup")).toBe("string");
  });
});

// --- 触发与状态流转 ---

describe("CronManager firing", () => {
  it("fires due task once, records running run, advances nextRunAt from fire time", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string; nextRunAt: string } };
    const fired = collect(mgr);

    clock.advance(61_000);
    mgr.runDueChecks(clock.now());

    expect(fired).toHaveLength(1);
    expect(fired[0].taskId).toBe(task.id);
    expect(fired[0].kind).toBe("bash");
    const run = mgr.listRuns(task.id)[0];
    expect(run.status).toBe("running");
    expect(run.trigger).toBe("schedule");
    // nextRunAt = 触发时刻 + 60s（而非旧的 nextRunAt + 60s）
    const tasks = mgr.listTasks();
    expect(Date.parse(tasks[0].nextRunAt!)).toBe(clock.now().getTime() + 60_000);
  });

  it("completeRun success clears failure counter and persists output", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string } };
    const fired = collect(mgr);
    clock.advance(61_000);
    mgr.runDueChecks(clock.now());

    mgr.completeRun(fired[0].runId, { ok: true, output: "hello\nworld" });

    const run = mgr.listRuns(task.id)[0];
    expect(run.status).toBe("success");
    expect(run.output).toBe("hello\nworld");
    expect(run.finishedAt).not.toBeNull();
    // 重开实例仍在（落盘）
    expect(makeManager(clock).listRuns(task.id)[0].status).toBe("success");
  });

  it("skips (no concurrent fire) while previous run of same task is in flight", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string } };
    const fired = collect(mgr);

    clock.advance(61_000);
    mgr.runDueChecks(clock.now()); // 第一次触发，不 complete
    clock.advance(120_000); // 越过下两个到点
    mgr.runDueChecks(clock.now());

    expect(fired).toHaveLength(1); // 没有再次发起
    const statuses = mgr.listRuns(task.id).map((r) => r.status);
    expect(statuses).toContain("skipped");
  });

  it("once task fires and reaches done; never fires again", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const runAt = clock.now().getTime() + 30_000;
    const added = mgr.addTask({ kind: "bash", schedule: { type: "once", runAt }, scheduleExpr: "at", payload: "x" });
    const fired = collect(mgr);

    clock.advance(31_000);
    mgr.runDueChecks(clock.now());
    expect(fired).toHaveLength(1);
    expect(mgr.listTasks()[0].status).toBe("done");

    mgr.completeRun(fired[0].runId, { ok: true });
    clock.advance(600_000);
    mgr.runDueChecks(clock.now());
    expect(fired).toHaveLength(1);
    expect(mgr.listTasks()[0].status).toBe("done");
  });
});

// --- 熔断 ---

describe("CronManager circuit breaker", () => {
  it("auto-pauses after 5 consecutive failures; resume resets and fires again", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string } };
    const fired = collect(mgr);

    for (let i = 0; i < 5; i++) {
      clock.advance(61_000);
      mgr.runDueChecks(clock.now());
      mgr.completeRun(fired[fired.length - 1].runId, { ok: false, error: `boom ${i}` });
    }

    let t = mgr.listTasks()[0];
    expect(t.status).toBe("paused");
    expect(t.pausedReason).toMatch(/circuit-breaker: 5 consecutive failures/);
    clock.advance(120_000);
    mgr.runDueChecks(clock.now());
    expect(fired).toHaveLength(5); // paused 后不再触发

    expect(mgr.resumeTask(task.id)).toBeUndefined();
    t = mgr.listTasks()[0];
    expect(t.status).toBe("active");
    expect(t.consecutiveFailures).toBe(0);
    clock.advance(120_000);
    mgr.runDueChecks(clock.now());
    expect(fired).toHaveLength(6); // 恢复后重新调度触发
  });

  it("a success between failures resets the counter", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    addIntervalTask(mgr, 60_000);
    const fired = collect(mgr);

    for (let round = 0; round < 6; round++) {
      clock.advance(61_000);
      mgr.runDueChecks(clock.now());
      // 每轮一败一成：失败计数永远到不了 5
      mgr.completeRun(fired[fired.length - 1].runId, { ok: false, error: "boom" });
      clock.advance(61_000);
      mgr.runDueChecks(clock.now());
      mgr.completeRun(fired[fired.length - 1].runId, { ok: true, output: "ok" });
    }
    expect(mgr.listTasks()[0].status).toBe("active");
    expect(mgr.listTasks()[0].consecutiveFailures).toBe(0);
  });
});

// --- 崩溃恢复 ---

describe("CronManager crash recovery", () => {
  it("marks stuck running runs as failed (interrupted) and counts toward breaker", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string } };
    const fired = collect(mgr);
    clock.advance(61_000);
    mgr.runDueChecks(clock.now()); // run 卡在 running（未 complete 即“崩溃”）
    expect(fired).toHaveLength(1);

    // 重启：新实例、新 sink
    const mgr2 = makeManager(clock);
    const fired2 = collect(mgr2);
    mgr2.start();
    mgr2.stop();

    const run = mgr2.listRuns(task.id).find((r) => r.runId === fired[0].runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("interrupted by restart");
    expect(mgr2.listTasks()[0].consecutiveFailures).toBe(1);
    expect(fired2).toHaveLength(0); // nextRunAt 已在触发时推进，不补跑
  });

  it("catch-up fires overdue active tasks exactly once on start", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const added = addIntervalTask(mgr, 3_600_000, "echo hi", "hourly");
    expect(added).toMatchObject({ task: { status: "active" } });

    clock.advance(3 * 3_600_000); // 停机 3 小时（错过 3 个到点）
    const mgr2 = makeManager(clock);
    const fired = collect(mgr2);
    mgr2.start();
    mgr2.stop();

    expect(fired).toHaveLength(1); // 合并补跑一次
    const taskId = (added as { task: { id: string } }).task.id;
    const run = mgr2.listRuns(taskId)[0];
    expect(run.trigger).toBe("catch-up");
    // nextRunAt 从现在重算：now + 1h
    expect(Date.parse(mgr2.listTasks()[0].nextRunAt!)).toBe(clock.now().getTime() + 3_600_000);
  });

  it("catch-up fires overdue once task once, then it is done", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const runAt = clock.now().getTime() + 30_000;
    mgr.addTask({ kind: "bash", schedule: { type: "once", runAt }, scheduleExpr: "at", payload: "x" });
    const taskId = mgr.listTasks()[0].id;

    clock.advance(120_000); // 逾期 90s
    const mgr2 = makeManager(clock);
    const fired = collect(mgr2);
    mgr2.start();
    mgr2.stop();

    expect(fired).toHaveLength(1);
    expect(mgr2.listRuns(taskId)[0].trigger).toBe("catch-up");
    expect(mgr2.listTasks()[0].status).toBe("done");
  });

  it("paused (circuit-broken) tasks are not caught up on restart", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000) as { task: { id: string } };
    const fired = collect(mgr);
    for (let i = 0; i < 5; i++) {
      clock.advance(61_000);
      mgr.runDueChecks(clock.now());
      mgr.completeRun(fired[fired.length - 1].runId, { ok: false, error: "boom" });
    }
    expect(mgr.listTasks()[0].status).toBe("paused");

    clock.advance(3_600_000);
    const mgr2 = makeManager(clock);
    const fired2 = collect(mgr2);
    mgr2.start();
    mgr2.stop();
    expect(fired2).toHaveLength(0);
    expect(mgr2.listTasks()[0].status).toBe("paused");
  });
});

// --- run 历史约束 ---

describe("CronManager run history", () => {
  it("caps runs at 100 entries (oldest dropped)", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    addIntervalTask(mgr, 60_000);
    const fired = collect(mgr);
    for (let i = 0; i < 105; i++) {
      clock.advance(61_000);
      mgr.runDueChecks(clock.now());
      mgr.completeRun(fired[fired.length - 1].runId, { ok: true, output: "ok" });
    }
    expect(mgr.listRuns().length).toBeLessThanOrEqual(100);
    expect(mgr.listRuns()[0].status).toBe("success"); // 最新保留
  });

  it("truncates run output beyond 4096 chars", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    addIntervalTask(mgr, 60_000);
    const fired = collect(mgr);
    clock.advance(61_000);
    mgr.runDueChecks(clock.now());
    const long = "x".repeat(10_000);
    mgr.completeRun(fired[0].runId, { ok: true, output: long });
    const run = mgr.listRuns()[0];
    expect(run.output!.length).toBeLessThan(5000);
    expect(run.output).toMatch(/\(\+.{1,6} chars\)$/);
  });
});

// --- CRUD 寻址与错误 ---

describe("CronManager task addressing", () => {
  it("remove/pause/resume accept id or name; unknown yields error", () => {
    const clock = makeClock();
    const mgr = makeManager(clock);
    const { task } = addIntervalTask(mgr, 60_000, "echo hi", "ticker") as { task: { id: string } };

    expect(mgr.pauseTask("ticker")).toBeUndefined();
    expect(mgr.listTasks()[0].status).toBe("paused");
    expect(typeof mgr.pauseTask(task.id)).toBe("string"); // 已暂停再暂停 = 错误
    expect(mgr.resumeTask(task.id)).toBeUndefined();
    expect(typeof mgr.resumeTask(task.id)).toBe("string"); // 未暂停再恢复 = 错误
    expect(mgr.removeTask("nope")).toMatch(/not found/);
    expect(mgr.removeTask("ticker")).toBeUndefined();
    expect(mgr.listTasks()).toHaveLength(0);
  });
});
