import chalk from "chalk";
import type { CronManager, CronTask, CronTaskKind } from "../cron/index.js";
import { parseCronExpr, parseDuration, parseTimeArg } from "../cron/parser.js";
import type { Command } from "./types.js";

const USAGE = `Usage: /cron <action>

Actions:
  list                       List scheduled tasks (default)
  add [--bash] <schedule> <payload...>
                             Schedule a task; --bash runs a shell command,
                             otherwise the payload is a prompt for the agent
    cron "<expr>"           Standard 5-field cron (minute hour dom month dow)
    every <duration>         Fixed interval (30s 10m 1h30m 1d)
    at <datetime>            One-shot (2026-11-28T09:00, "2026-11-28 09:00", 18:30)
  remove <id|name>           Delete a task
  pause <id|name>            Pause scheduling
  resume <id|name>           Resume a paused task (resets failure counter)
  runs [id|name]             Recent run history (last 10)
  help                       Show usage

Tasks persist in .kda/cron.json across restarts; overdue tasks are caught up
once on startup. Cron turns run with a restricted role (safe shell only);
5 consecutive failures auto-pause a task.`;

/** 本地时间 YYYY-MM-DD HH:mm（展示用，测试可复算） */
function fmtLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusMarker(t: CronTask): string {
  switch (t.status) {
    case "active":
      return chalk.green("[active]");
    case "paused":
      return chalk.red("[paused]");
    default:
      return chalk.gray("[done]");
  }
}

function renderList(mgr: CronManager): string {
  const tasks = mgr.listTasks();
  if (tasks.length === 0) return chalk.gray("No scheduled tasks. Use /cron add.");
  const lines = tasks.map((t) => {
    const next = t.nextRunAt ? `next: ${fmtLocal(t.nextRunAt)}` : chalk.gray("no upcoming");
    const fails = t.consecutiveFailures > 0 ? chalk.red(`  fails: ${t.consecutiveFailures}`) : "";
    const payload = t.payload.split("\n")[0].slice(0, 60);
    let line = `  ${chalk.yellow(t.id)}${t.name ? chalk.gray(` (${t.name})`) : ""}  ${statusMarker(t)}  ${chalk.cyan(t.scheduleExpr)}  ${next}${fails}`;
    line += `\n      ${chalk.gray(`${t.kind}: ${payload}`)}`;
    if (t.status === "paused" && t.pausedReason) line += `\n      ${chalk.red(t.pausedReason)}`;
    return line;
  });
  return `Cron tasks (${tasks.length}):\n${lines.join("\n")}`;
}

function renderRuns(mgr: CronManager, idOrName?: string): string {
  let taskId: string | undefined;
  if (idOrName) {
    const task = mgr.listTasks().find((t) => t.id === idOrName || t.name === idOrName);
    if (!task) return `Task "${idOrName}" not found.`;
    taskId = task.id;
  }
  const runs = mgr.listRuns(taskId).slice(0, 10);
  if (runs.length === 0) {
    return chalk.gray(taskId ? "No runs recorded for this task yet." : "No runs recorded yet.");
  }
  const lines = runs.map((r) => {
    const dur =
      r.finishedAt && r.startedAt
        ? ` (${((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)}s)`
        : "";
    const marker =
      r.status === "success" ? chalk.green("success")
        : r.status === "failed" ? chalk.red("failed")
          : r.status === "running" ? chalk.yellow("running")
            : chalk.gray("skipped");
    const tag = r.trigger === "catch-up" ? chalk.magenta(" catch-up") : "";
    const detail = r.error
      ? chalk.red(r.error.split("\n")[0].slice(0, 80))
      : r.output
        ? chalk.gray(r.output.split("\n")[0].slice(0, 80))
        : "";
    return `  ${chalk.yellow(r.runId)}  ${fmtLocal(r.startedAt)}  ${marker}${dur}${tag}\n      ${detail}`;
  });
  return `Recent runs (last ${runs.length}${taskId ? `, task ${taskId}` : ""}):\n${lines.join("\n")}`;
}

/** 从 rest 中取出一个引号包裹或裸 token 的参数，返回 [取出的值, 剩余部分] */
function takeQuotedOrToken(rest: string): [string, string] {
  const q = rest[0];
  if (q === "\"" || q === "'") {
    const end = rest.indexOf(q, 1);
    if (end === -1) return [rest.slice(1), ""];
    return [rest.slice(1, end), rest.slice(end + 1).trim()];
  }
  const sp = rest.search(/\s/);
  if (sp === -1) return [rest, ""];
  return [rest.slice(0, sp), rest.slice(sp + 1).trim()];
}

function confirmAdded(task: CronTask): string {
  const next = task.nextRunAt ? fmtLocal(task.nextRunAt) : "no upcoming match";
  return [
    `Task ${chalk.yellow(task.id)}${task.name ? ` (${task.name})` : ""} added.`,
    `  schedule: ${chalk.cyan(task.scheduleExpr)}  kind: ${task.kind}`,
    `  next run: ${next}`,
  ].join("\n");
}

/** /cron add 解析：[--bash] (cron "<expr>" | every <duration> | at <datetime>) <payload...> */
function doAdd(rest: string, mgr: CronManager): string {
  let kind: CronTaskKind = "prompt";
  let s = rest;
  if (/^--bash(\s|$)/.test(s)) {
    kind = "bash";
    s = s.replace(/^--bash\s*/, "");
  }

  const form = s.split(/\s+/)[0] ?? "";

  if (form === "cron") {
    const after = s.slice(4).trim();
    let expr: string;
    let payload: string;
    const q = after[0];
    if (q === "\"" || q === "'") {
      [expr, payload] = takeQuotedOrToken(after);
    } else {
      // 裸表达式：5 个独立 token（否则与 payload 无法区分）
      const tokens = after.split(/\s+/);
      if (tokens.length < 6) {
        return `Cron expression must be quoted or 5 bare fields.\nUsage: /cron add [--bash] cron "<expr>" <payload...> (see /cron help)`;
      }
      expr = tokens.slice(0, 5).join(" ");
      payload = tokens.slice(5).join(" ");
    }
    const fields = parseCronExpr(expr);
    if (typeof fields === "string") return `Invalid cron expression "${expr}": ${fields}`;
    if (!payload.trim()) return `Usage: /cron add [--bash] cron "${expr}" <payload...>`;
    const result = mgr.addTask({
      kind,
      schedule: { type: "cron", ...fields },
      scheduleExpr: `cron "${expr}"`,
      payload,
    });
    return typeof result === "string" ? result : confirmAdded(result.task);
  }

  if (form === "every") {
    const [dur, payload] = takeQuotedOrToken(s.slice(5).trim());
    const ms = parseDuration(dur);
    if (typeof ms === "string") return `Invalid duration: ${ms}`;
    if (!payload.trim()) return `Usage: /cron add [--bash] every ${dur} <payload...>`;
    const result = mgr.addTask({
      kind,
      schedule: { type: "interval", ms },
      scheduleExpr: `every ${dur}`,
      payload,
    });
    return typeof result === "string" ? result : confirmAdded(result.task);
  }

  if (form === "at") {
    const after = s.slice(2).trim();
    let timeStr: string;
    let payload: string;
    const q = after[0];
    if (q === "\"" || q === "'") {
      [timeStr, payload] = takeQuotedOrToken(after);
    } else {
      // 无引号："YYYY-MM-DD HH:mm" 允许空格分隔的两 token 形式
      const tokens = after.split(/\s+/);
      if (tokens.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(tokens[0]) && /^\d{1,2}:\d{2}$/.test(tokens[1])) {
        timeStr = `${tokens[0]} ${tokens[1]}`;
        payload = tokens.slice(2).join(" ");
      } else {
        [timeStr, payload] = takeQuotedOrToken(after);
      }
    }
    const runAt = parseTimeArg(timeStr, new Date());
    if (typeof runAt === "string") return `Invalid time: ${runAt}`;
    if (!payload.trim()) return `Usage: /cron add [--bash] at ${timeStr} <payload...>`;
    const result = mgr.addTask({
      kind,
      schedule: { type: "once", runAt },
      scheduleExpr: `at ${timeStr}`,
      payload,
    });
    return typeof result === "string" ? result : confirmAdded(result.task);
  }

  return `Unknown schedule form "${form || "(empty)"}.\nUsage: /cron add [--bash] (cron "<expr>" | every <duration> | at <datetime>) <payload...> (see /cron help)`;
}

export const cronCommand: Command = {
  name: "cron",
  description: "Manage scheduled tasks (cron / interval / one-shot)",
  usage: "/cron <list|add|remove|pause|resume|runs|help>",
  execute(args, ctx) {
    if (!ctx.cron) return "Cron scheduler is not available.";
    const mgr = ctx.cron;
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "list";

    switch (action) {
      case "list":
        return renderList(mgr);

      case "add":
        return doAdd(args.trim().slice(3).trim(), mgr);

      case "remove":
      case "pause":
      case "resume": {
        const target = parts[1];
        if (!target) return `Usage: /cron ${action} <id|name>`;
        const err =
          action === "remove" ? mgr.removeTask(target)
            : action === "pause" ? mgr.pauseTask(target)
              : mgr.resumeTask(target);
        return err ?? `Task ${target} ${action === "remove" ? "removed." : action === "pause" ? "paused." : "resumed."}`;
      }

      case "runs":
        return renderRuns(mgr, parts[1]);

      case "help":
      default:
        return USAGE;
    }
  },
};
