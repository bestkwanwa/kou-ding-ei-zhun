import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { createLogger, type Logger } from "../utils/logger.js";
import { nextRunAfter } from "./parser.js";
import {
  CRON_STATE_FILENAME,
  MAX_CONSECUTIVE_FAILURES,
  MAX_OUTPUT_CHARS,
  MAX_RUNS,
  MIN_INTERVAL_MS,
  TICK_MS,
  type CronRun,
  type CronSchedule,
  type CronState,
  type CronTask,
  type CronTaskKind,
  type CronTrigger,
  type CronTriggerSource,
} from "./types.js";

export interface CronManagerOptions {
  /** 时钟注入（测试用）；缺省真实时钟 */
  now?: () => Date;
}

export interface AddTaskSpec {
  /** 可选唯一短名（命令可用 id 或 name 寻址） */
  name?: string;
  kind: CronTaskKind;
  schedule: CronSchedule;
  /** 展示用原始表达式 */
  scheduleExpr: string;
  payload: string;
}

export type AddTaskResult = { task: CronTask } | string;

export interface CompleteRunResult {
  ok: boolean;
  output?: string;
  error?: string;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

function truncateText(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}…(+${s.length - MAX_OUTPUT_CHARS} chars)` : s;
}

/** run 历史封顶（保最近 MAX_RUNS 条；running 恒在尾部不受影响） */
function trimRuns(state: CronState): void {
  if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
}

/**
 * Cron 调度器：任务 CRUD、1s 轮询、run 记录、连续失败熔断、崩溃恢复。
 * 执行经 setOnDue 注入的 sink 进入 agent 输入队列（对称 gateway.setOnInbound），
 * 执行方完成后回调 completeRun 落结果。状态持久化到 <cwd>/.kda/cron.json（原子写）。
 */
export class CronManager {
  private readonly statePath: string;
  private readonly now: () => Date;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onDue: ((t: CronTrigger) => void) | null = null;
  /** 消费者接线前（start() 早于 runAgent 的输入层）暂存的到点事件，setOnDue 时冲刷 */
  private pendingTriggers: CronTrigger[] = [];
  /** 执行中任务的内存集合（防同任务并发；落盘状态为 run.status === "running"） */
  private runningTaskIds = new Set<string>();

  constructor(private cwd: string, opts: CronManagerOptions = {}) {
    this.statePath = resolve(cwd, ".kda", CRON_STATE_FILENAME);
    this.now = opts.now ?? (() => new Date());
    this.log = createLogger(cwd);
  }

  /** 注入到点 sink（agent 的输入多路复用器启动时接线）；冲刷接线前暂存的到点事件 */
  setOnDue(cb: (t: CronTrigger) => void): void {
    this.onDue = cb;
    const queued = this.pendingTriggers.splice(0);
    for (const t of queued) cb(t);
  }

  /**
   * 启动：崩溃恢复（卡在 running 的 run 判 failed 并计入熔断）→ 逾期任务合并补跑一次 → 开始轮询。
   * 不抛错（对齐 Channel.start 约定）。
   */
  start(): void {
    if (this.timer) return;
    const state = this.readState();
    const now = this.now();

    // 崩溃恢复：上次进程退出前未回报的 run 一律判失败
    let dirty = false;
    for (const run of state.runs) {
      if (run.status !== "running") continue;
      run.status = "failed";
      run.finishedAt = toIso(now);
      run.error = "interrupted by restart";
      const task = state.tasks[run.taskId];
      if (task) this.bumpFailure(task);
      dirty = true;
    }
    if (dirty) this.writeState(state);

    // 逾期补跑：合并为一次（trigger=catch-up），nextRunAt 从现在重算，不逐次补齐
    for (const task of Object.values(state.tasks)) {
      if (task.status !== "active" || !task.nextRunAt) continue;
      if (Date.parse(task.nextRunAt) <= now.getTime()) this.fireRun(state, task, "catch-up");
    }

    this.timer = setInterval(() => {
      try {
        this.runDueChecks(this.now());
      } catch (err) {
        console.warn(chalk.yellow(`[cron] tick failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }, TICK_MS);
  }

  /** 停止轮询（幂等）；在途 run 由执行方照常 completeRun 落盘 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 到点检查（tick 与测试共用）：active 且 nextRunAt <= now 的任务触发执行 */
  runDueChecks(now: Date): void {
    const state = this.readState();
    for (const task of Object.values(state.tasks)) {
      if (task.status !== "active" || !task.nextRunAt) continue;
      if (Date.parse(task.nextRunAt) <= now.getTime()) this.fireRun(state, task, "schedule");
    }
  }

  /** 执行方回报结果：落 run 终态、更新连续失败计数（触发熔断）。幂等（非 running 的 run 忽略） */
  completeRun(runId: string, result: CompleteRunResult): void {
    const state = this.readState();
    const run = state.runs.find((r) => r.runId === runId);
    if (!run || run.status !== "running") return;
    const task = state.tasks[run.taskId];
    this.runningTaskIds.delete(run.taskId);
    const now = this.now();
    run.finishedAt = toIso(now);
    run.status = result.ok ? "success" : "failed";
    if (result.output !== undefined) run.output = truncateText(result.output);
    if (result.error !== undefined) run.error = truncateText(result.error);
    if (task) {
      if (result.ok) task.consecutiveFailures = 0;
      else this.bumpFailure(task);
    }
    this.writeState(state);
    this.log.log(`[cron] run ${runId} → ${run.status}`);
  }

  /** 新增任务（同步持久化）；返回任务或错误信息（风格同 gateway.start） */
  addTask(spec: AddTaskSpec): AddTaskResult {
    const payload = spec.payload.trim();
    if (!payload) return "payload is empty";
    if (spec.schedule.type === "interval" && spec.schedule.ms < MIN_INTERVAL_MS) {
      return `interval must be >= ${MIN_INTERVAL_MS / 1000}s`;
    }
    const now = this.now();
    if (spec.schedule.type === "once" && spec.schedule.runAt <= now.getTime()) {
      return "scheduled time is in the past";
    }
    const state = this.readState();
    const name = spec.name?.trim();
    if (name && Object.values(state.tasks).some((t) => t.name === name)) {
      return `task name "${name}" already exists`;
    }
    const id = `t_${now.getTime()}_${rand4()}`;
    const next = nextRunAfter(spec.schedule, now);
    const task: CronTask = {
      id,
      name: name || null,
      kind: spec.kind,
      scheduleExpr: spec.scheduleExpr,
      schedule: spec.schedule,
      payload,
      status: "active",
      pausedReason: null,
      consecutiveFailures: 0,
      nextRunAt: next ? toIso(next) : null,
      lastRunAt: null,
      createdAt: toIso(now),
    };
    state.tasks[id] = task;
    this.writeState(state);
    this.log.log(`[cron] added ${id} (${spec.scheduleExpr}, kind=${spec.kind})`);
    return { task };
  }

  /** 删除任务（run 历史保留，仍可按 taskId 查询）；返回 undefined = 成功 */
  removeTask(idOrName: string): string | undefined {
    const state = this.readState();
    const task = this.resolveTask(state, idOrName);
    if (!task) return `Task "${idOrName}" not found.`;
    delete state.tasks[task.id];
    this.writeState(state);
    this.log.log(`[cron] removed ${task.id}`);
    return undefined;
  }

  /** 暂停（手动原因记录）；返回 undefined = 成功 */
  pauseTask(idOrName: string): string | undefined {
    const state = this.readState();
    const task = this.resolveTask(state, idOrName);
    if (!task) return `Task "${idOrName}" not found.`;
    if (task.status !== "active") return `Task "${idOrName}" is ${task.status}.`;
    task.status = "paused";
    task.pausedReason = "paused by user";
    this.writeState(state);
    return undefined;
  }

  /** 恢复调度并清零连续失败计数；逾期的 once 任务顺延为立即补跑 */
  resumeTask(idOrName: string): string | undefined {
    const state = this.readState();
    const task = this.resolveTask(state, idOrName);
    if (!task) return `Task "${idOrName}" not found.`;
    if (task.status === "done") return `Task "${idOrName}" is done (one-shot already fired); remove and re-add it.`;
    if (task.status === "active") return `Task "${idOrName}" is not paused.`;
    const now = this.now();
    task.status = "active";
    task.pausedReason = null;
    task.consecutiveFailures = 0;
    if (task.schedule.type === "once" && task.schedule.runAt <= now.getTime()) {
      task.nextRunAt = toIso(now); // 已逾期：下一 tick 立即补跑
    } else {
      const next = nextRunAfter(task.schedule, now);
      task.nextRunAt = next ? toIso(next) : null;
    }
    this.writeState(state);
    return undefined;
  }

  /** 任务列表（按创建时间排序） */
  listTasks(): CronTask[] {
    return Object.values(this.readState().tasks).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  /** run 历史（新的在前）；可按任务过滤 */
  listRuns(taskId?: string): CronRun[] {
    const runs = this.readState().runs;
    return (taskId ? runs.filter((r) => r.taskId === taskId) : runs).reverse();
  }

  // --- 内部实现 ---

  private resolveTask(state: CronState, idOrName: string): CronTask | undefined {
    return state.tasks[idOrName] ?? Object.values(state.tasks).find((t) => t.name === idOrName);
  }

  /** 连续失败计数 +1，达到阈值自动熔断（仅 active 任务会被暂停） */
  private bumpFailure(task: CronTask): void {
    task.consecutiveFailures++;
    if (task.status === "active" && task.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      task.status = "paused";
      task.pausedReason = `circuit-breaker: ${task.consecutiveFailures} consecutive failures`;
      console.warn(chalk.yellow(`[cron] task ${task.id} auto-paused (${task.pausedReason})`));
    }
  }

  /** 触发一次执行：建 running 记录、推进调度（once → done，先推进防补跑风暴）、发起到点事件 */
  private fireRun(state: CronState, task: CronTask, trigger: CronTriggerSource): void {
    const now = this.now();
    if (this.runningTaskIds.has(task.id)) {
      // 同任务上一 run 仍在执行：跳过本次，推进调度，不并发
      state.runs.push({
        runId: `r_${now.getTime()}_${rand4()}`,
        taskId: task.id,
        trigger,
        startedAt: toIso(now),
        finishedAt: toIso(now),
        status: "skipped",
        output: null,
        error: "previous run still in flight",
      });
      trimRuns(state);
      this.advanceSchedule(task, now);
      this.writeState(state);
      return;
    }
    const runId = `r_${now.getTime()}_${rand4()}`;
    state.runs.push({
      runId,
      taskId: task.id,
      trigger,
      startedAt: toIso(now),
      finishedAt: null,
      status: "running",
      output: null,
      error: null,
    });
    trimRuns(state);
    this.runningTaskIds.add(task.id);
    this.advanceSchedule(task, now);
    this.writeState(state);
    this.log.log(`[cron] fire ${task.id} (${trigger}) run=${runId}`);
    const t: CronTrigger = { runId, taskId: task.id, name: task.name, kind: task.kind, payload: task.payload };
    // 消费者可能尚未接线（start() 的补跑早于 agent 输入层）：暂存待冲刷，不丢事件
    if (this.onDue) this.onDue(t);
    else this.pendingTriggers.push(t);
  }

  /** 推进 nextRunAt（从 from 起算）；once 型触发即终态 done；一年内不再触发的表达式 → null */
  private advanceSchedule(task: CronTask, from: Date): void {
    if (task.schedule.type === "once") {
      task.status = "done";
      task.nextRunAt = null;
      return;
    }
    const next = nextRunAfter(task.schedule, from);
    task.nextRunAt = next ? toIso(next) : null;
  }

  /** 读状态；ENOENT = 空（静默）；其他读错误 / 损坏 JSON = 空 + 单次警告（plugins.json 模式） */
  private readState(): CronState {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tasks: {}, runs: [] };
      console.warn(chalk.yellow(`[cron] could not read ${CRON_STATE_FILENAME}, starting empty`));
      return { tasks: {}, runs: [] };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null && typeof parsed === "object" &&
        typeof (parsed as { tasks?: unknown }).tasks === "object" &&
        Array.isArray((parsed as { runs?: unknown }).runs)
      ) {
        return parsed as CronState; // 轻校验：字段级形状由本类的写入方保证
      }
    } catch {
      // JSON 语法错误，落到下方统一警告
    }
    console.warn(chalk.yellow(`[cron] invalid ${CRON_STATE_FILENAME}, starting empty`));
    return { tasks: {}, runs: [] };
  }

  /** 原子写（tmp + rename）：run 频繁落盘，崩溃在写中间不毁任务表；tasks 按 id 排序稳定输出 */
  private writeState(state: CronState): "ok" | "io-error" {
    try {
      mkdirSync(resolve(this.cwd, ".kda"), { recursive: true });
      const sorted = Object.fromEntries(Object.entries(state.tasks).sort(([a], [b]) => a.localeCompare(b)));
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ tasks: sorted, runs: state.runs }, null, 2)}\n`, "utf-8");
      renameSync(tmp, this.statePath);
      return "ok";
    } catch {
      console.warn(chalk.yellow(`[cron] could not write ${CRON_STATE_FILENAME} (state change not persisted)`));
      return "io-error";
    }
  }
}
