import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleManager } from "./role-manager.js";
import type { InboundMessage } from "../channels/types.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kda-security-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function inbound(channel: string, sender = "alice"): InboundMessage {
  return { id: "m1", channel, sender, text: "hi", timestamp: new Date().toISOString() };
}

describe("RoleManager", () => {
  it("default actor is terminal owner (covers initialPrompt)", () => {
    const m = new RoleManager(cwd);
    expect(m.current).toEqual({ role: "owner", source: "terminal" });
  });

  it("setTerminalActor resets to owner/terminal", () => {
    const m = new RoleManager(cwd);
    m.setChannelActor(inbound("web"));
    m.setTerminalActor();
    expect(m.current).toEqual({ role: "owner", source: "terminal" });
  });

  it("setChannelActor resolves role by channel name and captures sender", () => {
    const m = new RoleManager(cwd);
    m.setChannelRole("web", "collaborator");
    m.setChannelActor(inbound("web", "bob"));
    expect(m.current).toEqual({ role: "collaborator", source: "web", sender: "bob" });
  });

  it("unknown channel defaults to guest", () => {
    const m = new RoleManager(cwd);
    m.setChannelActor(inbound("web"));
    expect(m.current).toEqual({ role: "guest", source: "web", sender: "alice" });
    expect(m.getChannelRole("anything")).toBe("guest");
  });

  it("setChannelRole persists and round-trips on a new instance", () => {
    const m = new RoleManager(cwd);
    expect(m.setChannelRole("web", "collaborator")).toBe("ok");
    const raw = JSON.parse(readFileSync(join(cwd, ".kda", "security.json"), "utf-8"));
    expect(raw).toEqual({ channelRoles: { web: "collaborator" } });
    expect(new RoleManager(cwd).getChannelRole("web")).toBe("collaborator");
  });

  it("missing state file → defaults, no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new RoleManager(cwd);
    expect(m.listChannelRoles()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("corrupt JSON → defaults + one warning per read (plugins.json semantics)", () => {
    mkdirSync(join(cwd, ".kda"), { recursive: true });
    writeFileSync(join(cwd, ".kda", "security.json"), "{not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new RoleManager(cwd);
    expect(m.getChannelRole("web")).toBe("guest");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("invalid role values in state are dropped, valid ones kept", () => {
    mkdirSync(join(cwd, ".kda"), { recursive: true });
    writeFileSync(
      join(cwd, ".kda", "security.json"),
      JSON.stringify({ channelRoles: { web: "collaborator", evil: "superuser" } }),
      "utf-8",
    );
    const m = new RoleManager(cwd);
    expect(m.getChannelRole("web")).toBe("collaborator");
    expect(m.getChannelRole("evil")).toBe("guest");
  });
});
