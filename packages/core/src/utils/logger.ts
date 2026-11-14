import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Debug logger — writes to .kda/logs/debug.log in cwd
export function createLogger(cwd: string) {
  const logDir = resolve(cwd, ".kda", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, "debug.log");
  const ts = () => new Date().toISOString();
  return {
    log(...args: unknown[]) {
      const line = `[${ts()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ")}\n`;
      appendFileSync(logPath, line, "utf-8");
    },
    clear() {
      writeFileSync(logPath, `[${ts()}] === kda debug log started ===\n`, "utf-8");
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
