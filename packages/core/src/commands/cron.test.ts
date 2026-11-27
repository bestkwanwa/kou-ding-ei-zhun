import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronCommand } from "./cron.js";
import { CronManager } from "../cron/index.js";
import type { CronTrigger } from "../cron/index.js";
import type { CommandContext } from "./types.js";

// --- Helpers ---

let dir: string;
let clock: { t: number };

function makeCtx(): { ctx: CommandContext; mgr: CronManager } {
  const mgr = new CronManager(dir, { now: () => new Date(clock.t) });
  return { ctx: { cwd: dir, cron: mgr }, mgr };
}

function exec(args: string, ctx: CommandContext): string {
  return cronCommand.execute(args, ctx);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kda-cron-cmd-"));
  clock = { t: 1_700_000_000_000 };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("cronCommand availability", () => {
  it("reports unavailable without ctx.cron", () => {
    expect(exec("list", { cwd: dir })).toMatch(/not available/);
  });
});

describe("cronCommand add", () => {
  it("adds a prompt task from a quoted cron expression", () => {
    const { ctx, mgr } = makeCtx();
    const out = exec('add cron "*/5 * * * *" summarize open todos', ctx);
    expect(out).toMatch(/added/);
    expect(out).toMatch(/kind: prompt/);
    const tasks = mgr.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].scheduleExpr).toBe('cron "*/5 * * * *"');
    expect(tasks[0].payload).toBe("summarize open todos");
  });

  it("adds a bash task with --bash and bare 5-field cron tokens", () => {
    const { ctx, mgr } = makeCtx();
    const out = exec("add --bash cron */10 * * * 1-5 git pull --rebase", ctx);
    expect(out).toMatch(/kind: bash/);
    const tasks = mgr.listTasks();
    expect(tasks[0].kind).toBe("bash");
    expect(tasks[0].payload).toBe("git pull --rebase");
  });

  it("adds interval and one-shot tasks", () => {
    const { ctx, mgr } = makeCtx();
    expect(exec("add every 1h30m check the inbox", ctx)).toMatch(/every 1h30m/);
    expect(exec("add at 2099-01-01 09:00 write the report", ctx)).toMatch(/at 2099-01-01 09:00/);
    expect(mgr.listTasks()).toHaveLength(2);
  });

  it("rejects invalid schedule forms with readable errors", () => {
    const { ctx } = makeCtx();
    expect(exec('add cron "61 * * * *" x', ctx)).toMatch(/Invalid cron expression/);
    expect(exec("add every nope x", ctx)).toMatch(/Invalid duration/);
    expect(exec("add at 2000-01-01 09:00 x", ctx)).toMatch(/in the past/);
    expect(exec("add someday do it", ctx)).toMatch(/Unknown schedule form/);
    expect(exec('add cron "*/5 * * * *"', ctx)).toMatch(/Usage/); // 空 payload
  });
});

describe("cronCommand list", () => {
  it("shows empty hint and renders tasks with status/schedule/next", () => {
    const { ctx, mgr } = makeCtx();
    expect(exec("list", ctx)).toMatch(/No scheduled tasks/);

    exec("add --bash every 30s echo hi", ctx);
    const out = exec("list", ctx);
    expect(out).toMatch(/Cron tasks \(1\)/);
    expect(out).toMatch(/\[active\]/);
    expect(out).toMatch(/every 30s/);
    expect(out).toMatch(/bash: echo hi/);
  });

  it("renders circuit-breaker reason for paused tasks", () => {
    const { ctx, mgr } = makeCtx();
    const fired: CronTrigger[] = [];
    mgr.setOnDue((x) => fired.push(x));
    exec("add --bash every 30s exit 1", ctx);
    for (let i = 0; i < 5; i++) {
      clock.t += 31_000;
      mgr.runDueChecks(new Date(clock.t));
      mgr.completeRun(fired[fired.length - 1].runId, { ok: false, error: "Exit code: non-zero" });
    }
    const out = exec("list", ctx);
    expect(out).toMatch(/\[paused\]/);
    expect(out).toMatch(/circuit-breaker: 5 consecutive failures/);
  });
});

describe("cronCommand remove/pause/resume", () => {
  it("manages tasks by name with feedback", () => {
    const { ctx } = makeCtx();
    expect(exec("add every 30s x", ctx)).toMatch(/added/);
    const id = (/t_\w+/.exec(exec("list", ctx)) ?? [])[0];

    expect(exec("pause 30s-nope", ctx)).toMatch(/not found/);
    expect(exec(`pause ${id}`, ctx)).toMatch(/paused/);
    expect(exec(`pause ${id}`, ctx)).toMatch(/is paused/);
    expect(exec(`resume ${id}`, ctx)).toMatch(/resumed/);
    expect(exec(`remove ${id}`, ctx)).toMatch(/removed/);
    expect(exec("list", ctx)).toMatch(/No scheduled tasks/);
  });
});

describe("cronCommand runs", () => {
  it("renders run history with status and output", () => {
    const { ctx, mgr } = makeCtx();
    const fired: CronTrigger[] = [];
    mgr.setOnDue((x) => fired.push(x));
    exec("add --bash every 30s echo hi", ctx);
    const id = mgr.listTasks()[0].id;

    clock.t += 31_000;
    mgr.runDueChecks(new Date(clock.t));
    mgr.completeRun(fired[0].runId, { ok: true, output: "hi\n" });

    expect(exec("runs", ctx)).toMatch(/success/);
    expect(exec("runs", ctx)).toMatch(/bash.*hi|echo hi|"hi"|hi/s);
    expect(exec(`runs ${id}`, ctx)).toMatch(/success/);
    expect(exec("runs nope", ctx)).toMatch(/not found/);
  });

  it("hints when no runs recorded", () => {
    const { ctx } = makeCtx();
    exec("add every 30s x", ctx);
    expect(exec("runs", ctx)).toMatch(/No runs recorded/);
  });
});

describe("cronCommand help", () => {
  it("falls back to usage (empty args default to list)", () => {
    const { ctx } = makeCtx();
    expect(exec("", ctx)).toMatch(/No scheduled tasks/); // 缺省 list
    expect(exec("help", ctx)).toMatch(/Actions:/);
    expect(exec("bogus", ctx)).toMatch(/Usage: \/cron/);
  });
});
