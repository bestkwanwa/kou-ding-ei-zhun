import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { securityCommand } from "./security.js";
import { SecurityManager } from "../security/index.js";
import type { CommandContext } from "./types.js";
import type { InboundMessage } from "../channels/types.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kda-cmd-security-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function ctx(security: SecurityManager): CommandContext {
  return { cwd, security };
}

function inbound(channel: string): InboundMessage {
  return { id: "m1", channel, sender: "alice", text: "/security status", timestamp: new Date().toISOString() };
}

describe("/security command", () => {
  it("status shows current actor and channel roles with defaults marked", () => {
    const security = new SecurityManager({ cwd });
    security.roles.setChannelRole("web", "collaborator");
    const out = securityCommand.execute("status", ctx(security));
    expect(out).toContain("Current actor: owner (source: terminal)");
    expect(out).toContain("web  collaborator");
    expect(out).not.toContain("(default)");
  });

  it("status marks unconfigured channels as default guest", () => {
    const security = new SecurityManager({ cwd });
    const out = securityCommand.execute("status", ctx(security));
    expect(out).toContain("Channels: (none)");
  });

  it("set by owner persists the channel role", () => {
    const security = new SecurityManager({ cwd });
    const out = securityCommand.execute("set web collaborator", ctx(security));
    expect(out).toBe('Role "collaborator" set for channel "web".');
    expect(JSON.parse(readFileSync(join(cwd, ".kda", "security.json"), "utf-8"))).toEqual({
      channelRoles: { web: "collaborator" },
    });
    expect(security.roles.getChannelRole("web")).toBe("collaborator");
  });

  it("set by non-owner (channel guest) → error, no self-promotion", () => {
    const security = new SecurityManager({ cwd });
    security.roles.setChannelActor(inbound("web"));
    const out = securityCommand.execute("set web owner", ctx(security));
    expect(out).toContain("Error: [security] only the owner");
    expect(security.roles.getChannelRole("web")).toBe("guest");
  });

  it("invalid role / missing args → usage", () => {
    const security = new SecurityManager({ cwd });
    expect(securityCommand.execute("set web", ctx(security))).toContain("Usage: /security set");
    expect(securityCommand.execute("set web superuser", ctx(security))).toContain("Usage: /security set");
  });

  it("help shows usage", () => {
    const security = new SecurityManager({ cwd });
    expect(securityCommand.execute("help", ctx(security))).toContain("Usage: /security");
    expect(securityCommand.execute("", ctx(security)).length).toBeGreaterThan(0); // 空 args → status
  });

  it("missing ctx.security → not available", () => {
    expect(securityCommand.execute("status", { cwd })).toBe("Security is not available.");
  });
});
