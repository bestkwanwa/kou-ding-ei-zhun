import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelCommand } from "./channel.js";
import { ChannelGateway } from "../channels/index.js";
import type { Channel, ChannelInfo, ChannelStatus, InboundMessage, OutboundMessage } from "../channels/index.js";
import type { CommandContext } from "./types.js";

// --- Helpers ---

class FakeChannel implements Channel {
  name: string;
  description: string;
  private statusValue: ChannelStatus = "stopped";

  constructor(name: string, description = `${name} for tests`) {
    this.name = name;
    this.description = description;
  }

  start(): void {
    this.statusValue = "running";
  }
  async stop(): Promise<void> {
    this.statusValue = "stopped";
  }
  async send(): Promise<void> {}
  status(): ChannelInfo {
    return { name: this.name, description: this.description, status: this.statusValue };
  }
}

function makeCtx(channels?: ChannelGateway): CommandContext & { gateway?: ChannelGateway } {
  const cwd = mkdtempSync(join(tmpdir(), "kda-channel-cmd-"));
  if (!channels) return { cwd };
  return { cwd, channels };
}

function makeGateway(): ChannelGateway {
  const cwd = mkdtempSync(join(tmpdir(), "kda-channel-cmd-"));
  const gateway = new ChannelGateway(cwd);
  gateway.register(new FakeChannel("web", "Local browser chat test page"));
  return gateway;
}

// --- Subject ---

describe("channelCommand", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
    vi.restoreAllMocks();
  });

  function ctx(): CommandContext {
    const c = makeCtx(makeGateway());
    dirs.push(c.cwd);
    return c;
  }

  it("is wired with name/usage for the dispatcher", () => {
    expect(channelCommand.name).toBe("channel");
    expect(channelCommand.usage).toBe("/channel <list|start|stop|help>");
  });

  it("reports unavailable when ctx has no gateway", () => {
    expect(channelCommand.execute("list", makeCtx())).toBe("Channels are not available.");
  });

  it("lists channels with status markers (default action)", () => {
    const out = channelCommand.execute("", ctx());
    expect(out).toContain("Channels (1)");
    expect(out).toContain("web");
    expect(out).toContain("[stopped]");
    expect(out).toContain("Local browser chat test page");

    expect(channelCommand.execute("list", ctx())).toContain("web");
  });

  it("starts the web channel by default name", () => {
    const c = ctx();
    const out = channelCommand.execute("start", c);
    expect(out).toContain('Channel "web"');
    // 实际监听结果异步落 status；这里 fake channel 同步翻转
    expect(channelCommand.execute("list", c)).toContain("[running]");
  });

  it("start with explicit name and unknown-name error", () => {
    const c = ctx();
    expect(channelCommand.execute("start web", c)).toContain('"web"');
    expect(channelCommand.execute("start nope", c)).toContain('Channel "nope" not found.');
  });

  it("stops a running channel and guards usage/states", () => {
    const c = ctx();
    expect(channelCommand.execute("stop", c)).toBe("Usage: /channel stop <name>");
    expect(channelCommand.execute("stop web", c)).toContain("not running");

    channelCommand.execute("start web", c);
    expect(channelCommand.execute("stop web", c)).toBe('Channel "web" stopped.');
  });

  it("help and unknown action show usage", () => {
    const usage = channelCommand.execute("help", ctx());
    expect(usage).toContain("Usage: /channel");
    expect(channelCommand.execute("bogus", ctx())).toContain("Usage: /channel");
  });
});

describe("InboundMessage shape used by commands", () => {
  it("keeps the contract stable (id/channel/sender/text/timestamp)", () => {
    const msg: InboundMessage = {
      id: "x",
      channel: "web",
      sender: "a",
      text: "t",
      timestamp: new Date().toISOString(),
    };
    const out: OutboundMessage = { channel: "web", text: "r", timestamp: msg.timestamp, replyTo: msg.id };
    expect(out.replyTo).toBe("x");
  });
});
