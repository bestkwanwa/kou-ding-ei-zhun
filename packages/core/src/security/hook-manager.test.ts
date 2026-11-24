import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookManager, createBuiltinHooks } from "./hook-manager.js";
import type { Actor, Hook } from "./types.js";

let cwd: string;
const owner: Actor = { role: "owner", source: "terminal" };
const guest: Actor = { role: "guest", source: "web" };

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kda-hook-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("HookManager", () => {
  it("no hooks → allow, args and result unchanged", async () => {
    const m = new HookManager();
    const args = { path: "a.txt" };
    const before = await m.runBefore({ toolName: "write_file", args, actor: owner });
    expect(before).toEqual({ decision: { action: "allow" }, args });
    expect(await m.runAfter({ toolName: "write_file", args, actor: owner }, "ok")).toBe("ok");
  });

  it("before hooks rewrite args in registration order", async () => {
    const m = new HookManager();
    m.register({ name: "a", beforeExecute: (i) => ({ action: "allow", args: { ...i.args, step: "a" } }) });
    m.register({ name: "b", beforeExecute: (i) => ({ action: "allow", args: { ...i.args, step: `${String(i.args.step)}+b` } }) });
    const before = await m.runBefore({ toolName: "t", args: { x: 1 }, actor: owner });
    expect(before.args).toEqual({ x: 1, step: "a+b" });
  });

  it("first deny short-circuits later hooks", async () => {
    const later = vi.fn(() => ({ action: "allow" as const }));
    const m = new HookManager();
    m.register({ name: "deny-first", beforeExecute: () => ({ action: "deny", reason: "nope" }) });
    m.register({ name: "later", beforeExecute: later });
    const before = await m.runBefore({ toolName: "t", args: {}, actor: owner });
    expect(before.decision).toEqual({ action: "deny", reason: "nope" });
    expect(later).not.toHaveBeenCalled();
  });

  it("sync and async hook forms both work", async () => {
    const m = new HookManager();
    m.register({ name: "sync", beforeExecute: () => ({ action: "allow", args: { a: 1 } }) });
    m.register({
      name: "async",
      beforeExecute: async (i) => ({ action: "allow", args: { ...i.args, b: 2 } }),
    });
    const before = await m.runBefore({ toolName: "t", args: {}, actor: owner });
    expect(before.args).toEqual({ a: 1, b: 2 });
  });

  it("after hooks rewrite the result in order", async () => {
    const m = new HookManager();
    m.register({ name: "a", afterExecute: (_i, r) => `${r}!` });
    m.register({ name: "b", afterExecute: async (_i, r) => `[${r}]` });
    expect(await m.runAfter({ toolName: "t", args: {}, actor: owner }, "ok")).toBe("[ok!]");
  });

  it("throwing before hook → deny (fail-closed) + warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new HookManager();
    m.register({ name: "boom", beforeExecute: () => { throw new Error("kaboom"); } });
    const before = await m.runBefore({ toolName: "t", args: {}, actor: owner });
    expect(before.decision.action).toBe("deny");
    expect(before.decision.reason).toContain("boom");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("throwing after hook → result unchanged + warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new HookManager();
    m.register({ name: "boom", afterExecute: () => { throw new Error("kaboom"); } });
    expect(await m.runAfter({ toolName: "t", args: {}, actor: owner }, "original")).toBe("original");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("hooks that only define afterExecute are skipped by runBefore and vice versa", async () => {
    const beforeSeen: string[] = [];
    const m = new HookManager();
    m.register({ name: "only-after", afterExecute: (_i, r) => r });
    m.register({ name: "only-before", beforeExecute: () => { beforeSeen.push("x"); return { action: "allow" }; } });
    await m.runBefore({ toolName: "t", args: {}, actor: owner });
    await m.runAfter({ toolName: "t", args: {}, actor: owner }, "r");
    expect(beforeSeen).toEqual(["x"]); // only-before 被跳过 after、only-after 被跳过 before，无异常
  });
});

describe("builtin write-path-containment hook", () => {
  function manager(): HookManager {
    return new HookManager(createBuiltinHooks(cwd));
  }
  const input = (path: string, actor: Actor) => ({ toolName: "write_file", args: { path }, actor });

  it("collaborator writing inside cwd → allow", async () => {
    const collab: Actor = { role: "collaborator", source: "web" };
    expect((await manager().runBefore(input("src/a.ts", collab))).decision.action).toBe("allow");
  });

  it("collaborator writing outside cwd → deny", async () => {
    const collab: Actor = { role: "collaborator", source: "web" };
    for (const p of ["../outside.txt", "/tmp/evil.txt", join(cwd, "..", "escape.txt")]) {
      const before = await manager().runBefore(input(p, collab));
      expect(before.decision.action, p).toBe("deny");
      expect(before.decision.reason).toContain("outside");
    }
  });

  it("owner is exempt (writes anywhere)", async () => {
    expect((await manager().runBefore(input("../outside.txt", owner))).decision.action).toBe("allow");
    expect((await manager().runBefore(input("/etc/hosts", owner))).decision.action).toBe("allow");
  });

  it("non-write tools and missing path arg pass through", async () => {
    const m = manager();
    expect((await m.runBefore({ toolName: "run_command", args: { command: "ls" }, actor: guest })).decision.action).toBe("allow");
    expect((await m.runBefore({ toolName: "write_file", args: {}, actor: guest })).decision.action).toBe("allow");
  });
});
