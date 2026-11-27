/** 任务类型：prompt = 作为一轮 agent 会话执行；bash = 直接执行 shell 命令（不经过 LLM） */
export type CronTaskKind = "prompt" | "bash";

/** active = 正常调度；paused = 手动或熔断暂停；done = 一次性任务已触发（终态） */
export type CronTaskStatus = "active" | "paused" | "done";

/** running = 已触发待回报（含执行中）；skipped = 上一 run 未完成时到点跳过 */
export type CronRunStatus = "running" | "success" | "failed" | "skipped";

/** schedule = 正常到点；catch-up = 重启后逾期补跑 */
export type CronTriggerSource = "schedule" | "catch-up";

/**
 * 标准 cron 五字段（分 时 日 月 周），每个字段为命中值集合；
 * null = `*`（不限制）。周 0-6，7 归一化为 0（周日）。
 */
export interface CronFields {
  minute: number[] | null;
  hour: number[] | null;
  dom: number[] | null;
  month: number[] | null;
  dow: number[] | null;
}

/** 三种调度：标准 cron 表达式 / 固定间隔 / 一次性 */
export type CronSchedule =
  | ({ type: "cron" } & CronFields)
  | { type: "interval"; ms: number }
  | { type: "once"; runAt: number };

export interface CronTask {
  id: string;
  /** 可选短名（唯一），命令可用 id 或 name 寻址 */
  name: string | null;
  kind: CronTaskKind;
  /** 展示用原始表达式（如 `0 9 * * *` / `every 30m` / `at 2026-11-28T09:00`） */
  scheduleExpr: string;
  schedule: CronSchedule;
  /** prompt 文本或 shell 命令 */
  payload: string;
  status: CronTaskStatus;
  /** 暂停原因（熔断时为 "circuit-breaker: N consecutive failures"） */
  pausedReason: string | null;
  consecutiveFailures: number;
  /** 下次触发时间（ISO）；null = 一年内不再触发（如 2 月 30 日） */
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

export interface CronRun {
  runId: string;
  taskId: string;
  trigger: CronTriggerSource;
  startedAt: string;
  finishedAt: string | null;
  status: CronRunStatus;
  /** 任务输出（截断到 MAX_OUTPUT_CHARS） */
  output: string | null;
  error: string | null;
}

/** 到点事件：经 setOnDue 注入 agent 输入 FIFO（对称 gateway.setOnInbound） */
export interface CronTrigger {
  runId: string;
  taskId: string;
  name: string | null;
  kind: CronTaskKind;
  payload: string;
}

export interface CronState {
  tasks: Record<string, CronTask>;
  /** 全局最近的 run 记录（封顶 MAX_RUNS 条，新的在后） */
  runs: CronRun[];
}

/** 状态文件（<cwd>/.kda/cron.json） */
export const CRON_STATE_FILENAME = "cron.json";

/** 调度器轮询间隔 */
export const TICK_MS = 1000;

/** 连续失败达到该次数自动熔断（pause） */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** run 历史封顶条数（全局） */
export const MAX_RUNS = 100;

/** 单条 run 输出/错误截断长度 */
export const MAX_OUTPUT_CHARS = 4096;

/** nextRunAfter 对 cron 表达式的向前搜索上限（一年），超限视为不再触发 */
export const CRON_SEARCH_LIMIT_MS = 365 * 24 * 60 * 60 * 1000;

/** 固定间隔任务的最小间隔（防过密任务吃资源） */
export const MIN_INTERVAL_MS = 1000;
