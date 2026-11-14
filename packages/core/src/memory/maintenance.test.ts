import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLastMaintenanceAt,
  isMaintenanceOverdue,
  isMaintenanceDue,
  maintenancePending,
} from "./maintenance.js";
import { MAINTENANCE_MARKER_ID } from "./types.js";
import type { SessionMetadata } from "../session/types.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-maint-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-13T12:00:00.000Z");
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

function sessionAt(createdAt: string): SessionMetadata {
  return { id: "s", createdAt, updatedAt: createdAt, summary: "", messageCount: 0 };
}

function seedMarker(cwd: string, updated: string) {
  const memDir = join(cwd, ".kda", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, `${MAINTENANCE_MARKER_ID}.md`),
    `---\nname: ${MAINTENANCE_MARKER_ID}\ntype: dynamic\ndescription: maintenance record\nupdated: ${updated}\n---\nreport\n`,
    "utf-8",
  );
}

function sessions(n: number, newestHoursAgo = 25): SessionMetadata[] {
  // n 个 createdAt 均晚于 newestHoursAgo+1 小时前的标记时间
  return Array.from({ length: n }, (_, i) => sessionAt(iso(newestHoursAgo - i)));
}

// --- Subject ---

describe("readLastMaintenanceAt", () => {
  it("returns null when missing or malformed, updated when present", () => {
    const cwd = makeCwd();
    expect(readLastMaintenanceAt(cwd)).toBeNull();
    const memDir = join(cwd, ".kda", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${MAINTENANCE_MARKER_ID}.md`), "not frontmatter\n", "utf-8");
    expect(readLastMaintenanceAt(cwd)).toBeNull();
    seedMarker(cwd, "2026-11-10T00:00:00.000Z");
    expect(readLastMaintenanceAt(cwd)).toBe("2026-11-10T00:00:00.000Z");
  });
});

describe("isMaintenanceOverdue", () => {
  it("treats a missing or unparseable marker as overdue", () => {
    expect(isMaintenanceOverdue(null, NOW)).toBe(true);
    expect(isMaintenanceOverdue(undefined, NOW)).toBe(true);
    expect(isMaintenanceOverdue("garbage", NOW)).toBe(true);
  });

  it("is false within 24h and true beyond", () => {
    expect(isMaintenanceOverdue(iso(1), NOW)).toBe(false);
    expect(isMaintenanceOverdue(iso(24), NOW)).toBe(false); // 恰好 24h 不算超过
    expect(isMaintenanceOverdue(iso(25), NOW)).toBe(true);
  });
});

describe("isMaintenanceDue", () => {
  it("requires 5+ sessions since the last run AND more than 24h", () => {
    const old = iso(48);
    expect(isMaintenanceDue(sessions(5), old, NOW)).toBe(true);
    expect(isMaintenanceDue(sessions(4), old, NOW)).toBe(false);
    expect(isMaintenanceDue(sessions(5), iso(1), NOW)).toBe(false); // 时间未到
  });

  it("counts only sessions created after the last run", () => {
    const lastRun = iso(30);
    const before = [sessionAt(iso(40)), sessionAt(iso(35))];
    const after = sessions(5, 29);
    expect(isMaintenanceDue([...before, ...after], lastRun, NOW)).toBe(true);
    expect(isMaintenanceDue([...before, ...after.slice(0, 4)], lastRun, NOW)).toBe(false);
  });

  it("counts all sessions when there is no marker, still requiring 5+", () => {
    expect(isMaintenanceDue(sessions(4), null, NOW)).toBe(false);
    expect(isMaintenanceDue(sessions(5), null, NOW)).toBe(true);
  });
});

describe("maintenancePending", () => {
  it("reflects the on-disk marker freshness (cheap per-render gate)", () => {
    const cwd = makeCwd();
    expect(maintenancePending(cwd, NOW)).toBe(true); // 无标记 → 待整理
    seedMarker(cwd, iso(1));
    expect(maintenancePending(cwd, NOW)).toBe(false); // 新鲜标记 → 指令撤下
    seedMarker(cwd, iso(30));
    expect(maintenancePending(cwd, NOW)).toBe(true);
  });
});
