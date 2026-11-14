import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { MAINTENANCE_MARKER_ID } from "./types.js";
import type { SessionMetadata } from "../session/types.js";

/** 触发门槛：自上次整理以来积累的新会话数 */
export const MAINTENANCE_MIN_SESSIONS = 5;
/** 触发门槛：距上次整理的最小间隔 */
export const MAINTENANCE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 上次整理时间 = 保留记忆（dynamic-memory-maintenance）的 frontmatter updated 字段。
 * 缺失/损坏/字段非法 → null（视为从未整理）。直接读文件而非 MemoryStore.read，避免记 lastRead。
 */
export function readLastMaintenanceAt(cwd: string): string | null {
  try {
    const raw = readFileSync(resolve(cwd, ".kda", "memory", `${MAINTENANCE_MARKER_ID}.md`), "utf-8");
    const { fm } = parseFrontmatter(raw);
    return typeof fm.updated === "string" && fm.updated ? fm.updated : null;
  } catch {
    return null;
  }
}

/** 时间半判定（便宜）：无标记/时间非法/超 24 小时 → true */
export function isMaintenanceOverdue(lastRunAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastRunAt) return true;
  const t = Date.parse(lastRunAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > MAINTENANCE_MIN_INTERVAL_MS;
}

/** 会话半判定：createdAt 晚于 lastRunAt 的会话数 ≥ MAINTENANCE_MIN_SESSIONS，且距上次整理超时 */
export function isMaintenanceDue(
  sessions: readonly SessionMetadata[],
  lastRunAt: string | null,
  now: Date = new Date(),
): boolean {
  const newSessions = lastRunAt
    ? sessions.filter((s) => s.createdAt > lastRunAt).length
    : sessions.length;
  return newSessions >= MAINTENANCE_MIN_SESSIONS && isMaintenanceOverdue(lastRunAt, now);
}

/** 会话启动时一次性调用（含 SessionStore.list() 全量读盘，绝不进每轮 prompt 渲染） */
export function shouldRunMaintenance(
  cwd: string,
  sessions: readonly SessionMetadata[],
  now: Date = new Date(),
): boolean {
  return isMaintenanceDue(sessions, readLastMaintenanceAt(cwd), now);
}

/** 段落每轮渲染的廉价复查：磁盘上的完成标记是否仍未到期（模型本会话 save 标记后 → false → 指令撤下） */
export function maintenancePending(cwd: string, now: Date = new Date()): boolean {
  return isMaintenanceOverdue(readLastMaintenanceAt(cwd), now);
}
