import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityManager } from "./security-manager.js";
import type { InboundMessage } from "../channels/types.js";
import type { Tool } from "../tools/types.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kda-secmgr-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function inbound(channel: string): InboundMessage {
  return { id: "m1", channel, sender: "alice", text: "hi", timestamp: new Date().toISOString() };
}

function tool(partial: Partial<Tool> & { name: string }): Tool {
  return {
    description: "test",
    parameters: {} as Tool["parameters"],
    execute: async () => "ok",
    ...partial,
  };
}

describe("SecurityManager.check", () => {
  it("guest + mutating tool → deny with reason", async () => {
    const m = new SecurityManager({ cwd });
    m.roles.setChannelActor(inbound("web"));
    const d = await m.check(tool({ name: "write_file" }), { path: "a.txt" });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("read-only");
  });

  it("guest + readOnly tool → allow", async () => {
    const m = new SecurityManager({ cwd });
    m.roles.setChannelActor(inbound("web"));
    expect((await m.check(tool({ name: "read_file", readOnly: true }), {})).action).toBe("allow");
  });

  it("guest + run_command → deny without LLM call (no getModel needed)", async () => {
    const m = new SecurityManager({ cwd, getModel: () => { throw new Error("must not be called"); } });
    m.roles.setChannelActor(inbound("web"));
    const d = await m.check(tool({ name: "run_command" }), { command: "ls" });
    expect(d.action).toBe("deny");
  });

  it("owner + risky command → warn with the rule reason spliced in", async () => {
    const m = new SecurityManager({ cwd });
    const d = await m.check(tool({ name: "run_command" }), { command: "git push origin main" });
    expect(d.action).toBe("warn");
    expect(d.reason).toContain("git-mutate");
  });

  it("owner + dangerous command → deny for all roles", async () => {
    const m = new SecurityManager({ cwd });
    const d = await m.check(tool({ name: "run_command" }), { command: "rm -rf /" });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("dangerous");
  });

  it("collaborator + safe command → allow; risky → deny", async () => {
    const m = new SecurityManager({ cwd });
    m.roles.setChannelRole("web", "collaborator");
    m.roles.setChannelActor(inbound("web"));
    expect((await m.check(tool({ name: "run_command" }), { command: "ls -la" })).action).toBe("allow");
    expect((await m.check(tool({ name: "run_command" }), { command: "git push" })).action).toBe("deny");
  });

  it("getModel throwing → still returns a decision (fail-closed)", async () => {
    const m = new SecurityManager({ cwd, getModel: () => { throw new Error("boom"); } });
    // "echo hi; ls" 无规则命中 → 走 LLM → getModel 抛错 → BashRiskMonitor catch → 默认 risky → owner warn
    const d = await m.check(tool({ name: "run_command" }), { command: "echo hi; ls" });
    expect(d.action).toBe("warn");
  });

  it("denied dangerous target blocks risky variants in the same turn (rm -rf → rm)", async () => {
    const m = new SecurityManager({ cwd });
    const first = await m.check(tool({ name: "run_command" }), { command: `rm -rf ${cwd}/target.txt` });
    expect(first.action).toBe("deny");
    const retry = await m.check(tool({ name: "run_command" }), { command: `rm ${cwd}/target.txt` });
    expect(retry.action).toBe("deny");
    expect(retry.reason).toContain("denied earlier");
    // 无关目标不受影响（owner → risky → warn）
    const other = await m.check(tool({ name: "run_command" }), { command: `rm ${cwd}/other.txt` });
    expect(other.action).toBe("warn");
  });

  it("resetDeniedIntents re-authorizes the target (next user turn)", async () => {
    const m = new SecurityManager({ cwd });
    await m.check(tool({ name: "run_command" }), { command: `rm -rf ${cwd}/target.txt` });
    m.resetDeniedIntents();
    const d = await m.check(tool({ name: "run_command" }), { command: `rm ${cwd}/target.txt` });
    expect(d.action).toBe("warn"); // owner risky 警告放行
  });

  it("missing command arg → falls through to default risky, never rejects", async () => {
    const m = new SecurityManager({ cwd });
    // command 缺失 → String("") → 无规则命中 → 无模型 → 默认 risky → owner warn
    const d = await m.check(tool({ name: "run_command" }), {});
    expect(d.action).toBe("warn");
  });
});

describe("SecurityManager composition", () => {
  it("exposes builtin hooks (write-path containment) via hooks manager", async () => {
    const m = new SecurityManager({ cwd });
    m.roles.setChannelRole("web", "collaborator");
    m.roles.setChannelActor(inbound("web"));
    const before = await m.hooks.runBefore({
      toolName: "write_file",
      args: { path: "../escape.txt" },
      actor: m.currentActor,
    });
    expect(before.decision.action).toBe("deny");
  });

  it("currentActor reflects role manager state", () => {
    const m = new SecurityManager({ cwd });
    expect(m.currentActor).toEqual({ role: "owner", source: "terminal" });
    m.roles.setChannelActor(inbound("web"));
    expect(m.currentActor).toEqual({ role: "guest", source: "web", sender: "alice" });
  });
});
