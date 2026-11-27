import { CronManager } from "./manager.js";

export { CronManager } from "./manager.js";
export type { CronManagerOptions, AddTaskSpec, AddTaskResult, CompleteRunResult } from "./manager.js";
export { parseCronExpr, parseDuration, parseTimeArg, nextRunAfter } from "./parser.js";
export type {
  CronFields,
  CronRun,
  CronRunStatus,
  CronSchedule,
  CronState,
  CronTask,
  CronTaskKind,
  CronTaskStatus,
  CronTrigger,
  CronTriggerSource,
} from "./types.js";

/** 默认实例（CLI 层装配用；真实时钟 + 1s 轮询） */
export function createDefaultCronManager(cwd: string): CronManager {
  return new CronManager(cwd);
}
