import { CRON_SEARCH_LIMIT_MS, MIN_INTERVAL_MS, type CronFields, type CronSchedule } from "./types.js";

// --- cron 表达式解析（5 字段：分 时 日 月 周） --@

/** 字段名与合法范围（dow 0-7，7 归一化为 0 = 周日） */
const FIELDS: readonly { name: keyof CronFields; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

/**
 * 解析标准 cron 表达式，返回字段集合（null = 星号通配）；非法返回错误信息。
 * 支持每字段：星号、`N`、`N-M`、步长（`X/S`，X 为星号/N/N-M，单值步长到字段上限）与逗号列表。
 */
export function parseCronExpr(expr: string): CronFields | string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `expected 5 fields (minute hour dom month dow), got ${parts.length}`;
  }
  const out: CronFields = { minute: null, hour: null, dom: null, month: null, dow: null };
  for (let i = 0; i < 5; i++) {
    const { name, min, max } = FIELDS[i];
    const parsed = parseField(parts[i], min, max);
    if (typeof parsed === "string") return `field "${name}": ${parsed}`;
    out[name] = parsed;
  }
  // dow 归一化：7 → 0（周日）；两个表示都出现时去重
  if (out.dow) {
    const days = new Set(out.dow.map((d) => d % 7));
    out.dow = [...days].sort((a, b) => a - b);
  }
  return out;
}

/** 解析单个字段；返回排序去重的值集合、null（= `*`）或错误信息 */
function parseField(field: string, min: number, max: number): number[] | null | string {
  if (field === "*") return null;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!m) return `invalid syntax "${part}" (supported: * N N-M */S N-M/S list)`;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return `step must be >= 1 in "${part}"`;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
      if (lo > hi) return `inverted range in "${part}"`;
    } else {
      lo = parseInt(m[1], 10);
      // vixie 语义：单值 + 步长（N/S）= 从 N 到字段上限
      hi = m[2] ? max : lo;
    }
    if (lo < min || hi > max) return `value out of range ${min}-${max} in "${part}"`;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** cron 字段集合是否命中本地时间 d（vixie 语义：dom 与 dow 均显式受限时取 OR） */
function matchesCron(f: CronFields, d: Date): boolean {
  if (f.minute && !f.minute.includes(d.getMinutes())) return false;
  if (f.hour && !f.hour.includes(d.getHours())) return false;
  if (f.month && !f.month.includes(d.getMonth() + 1)) return false;
  const domOk = !f.dom || f.dom.includes(d.getDate());
  const dowOk = !f.dow || f.dow.includes(d.getDay());
  return f.dom && f.dow ? domOk || dowOk : domOk && dowOk;
}

// --- 下次触发时间 --@

/**
 * 计算 from 之后（严格大于）的下一次触发时间；不再触发返回 null。
 * cron 型按分钟向前迭代（本地时钟；DST 间隙自然跳过），搜索上限一年。
 */
export function nextRunAfter(schedule: CronSchedule, from: Date): Date | null {
  switch (schedule.type) {
    case "interval":
      return new Date(from.getTime() + schedule.ms);
    case "once":
      return schedule.runAt > from.getTime() ? new Date(schedule.runAt) : null;
    case "cron": {
      // 对齐到 from 之后的下一个分钟边界（cron 按整分触发）
      let cursor = new Date(
        from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0,
      );
      if (cursor.getTime() <= from.getTime()) cursor = new Date(from.getTime() + 60_000);
      const limit = from.getTime() + CRON_SEARCH_LIMIT_MS;
      for (let ts = cursor.getTime(); ts <= limit; ts += 60_000) {
        const d = new Date(ts);
        if (matchesCron(schedule, d)) return d;
      }
      return null;
    }
    default:
      return null; // 类型穷尽（防御畸形输入）
  }
}

// --- 间隔与时间点解析 --@

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 解析间隔串（如 `30s` `10m` `1h30m` `1d`）为毫秒；非法返回错误信息 */
export function parseDuration(input: string): number | string {
  const s = input.trim().toLowerCase();
  if (!s) return "empty duration";
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
    total += parseFloat(m[1]) * DURATION_UNIT_MS[m[2]];
    consumed += m[0].length;
  }
  // matchAll 只覆盖合法片段：长度对不上 = 中间混有非法字符
  if (consumed !== s.length || total <= 0) {
    return `invalid duration "${input}" (examples: 30s 10m 1h30m 1d)`;
  }
  const ms = Math.round(total);
  if (ms < MIN_INTERVAL_MS) return `interval must be >= 1s`;
  return ms;
}

/**
 * 解析时间点参数为 epoch 毫秒（本地时钟）；非法返回错误信息。
 * 三种形式：`2026-11-28T09:00`、`2026-11-28 09:00[:ss]`、`18:30`（今天已过则顺延明天）。
 */
export function parseTimeArg(input: string, now: Date): number | string {
  const s = input.trim();
  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (timeOnly) {
    const h = parseInt(timeOnly[1], 10);
    const mi = parseInt(timeOnly[2], 10);
    if (h > 23 || mi > 59) return `invalid time "${input}"`;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (full) {
    const [, y, mo, d, h, mi, sec] = full;
    const dt = new Date(
      parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10),
      parseInt(h, 10), parseInt(mi, 10), sec ? parseInt(sec, 10) : 0, 0,
    );
    // 溢出校验：如 2 月 31 日会滚到 3 月
    if (dt.getMonth() !== parseInt(mo, 10) - 1 || dt.getDate() !== parseInt(d, 10)) {
      return `invalid date "${input}"`;
    }
    return dt.getTime();
  }
  return `invalid datetime "${input}" (examples: 2026-11-28T09:00, "2026-11-28 09:00", 18:30)`;
}
