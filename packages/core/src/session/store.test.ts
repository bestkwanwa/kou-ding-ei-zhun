import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";

// --- Helpers ---

let dir: string;

function makeCwd(): string {
  dir = mkdtempSync(join(tmpdir(), "kda-session-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// --- Subject ---

describe("SessionStore loadedSkills persistence", () => {
  it("roundtrips loadedSkills through save/load", () => {
    const cwd = makeCwd();
    const store = new SessionStore(cwd);
    const session = store.create("deploy the app");
    session.discoveredTools = ["fetch_url"];
    session.loadedSkills = ["deploy", "review"];
    session.messages = [{ role: "user", content: "hello" }];
    store.save(session);

    const loaded = store.load(session.id)!;
    expect(loaded.loadedSkills).toEqual(["deploy", "review"]);
    expect(loaded.discoveredTools).toEqual(["fetch_url"]);
    expect(loaded.messages).toHaveLength(1);
  });

  it("create() starts with empty loadedSkills (startup = unactivated)", () => {
    const store = new SessionStore(makeCwd());
    expect(store.create("x").loadedSkills).toEqual([]);
  });

  it("defaults loadedSkills to [] for old session files missing the field", () => {
    const cwd = makeCwd();
    const sessionsDir = join(cwd, ".kda", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // 旧格式 meta 行：无 loadedSkills 字段
    const meta = {
      type: "meta",
      id: "abcd1234",
      createdAt: "2026-11-14T00:00:00.000Z",
      updatedAt: "2026-11-14T00:00:00.000Z",
      summary: "old session",
      discoveredTools: [],
    };
    const msg = { type: "message", timestamp: "2026-11-14T00:00:00.000Z", message: { role: "user", content: "hi" } };
    writeFileSync(join(sessionsDir, "abcd1234.jsonl"), `${JSON.stringify(meta)}\n${JSON.stringify(msg)}\n`, "utf-8");

    const loaded = new SessionStore(cwd).load("abcd1234")!;
    expect(loaded.loadedSkills).toEqual([]);
    expect(loaded.messages).toHaveLength(1);
  });
});
