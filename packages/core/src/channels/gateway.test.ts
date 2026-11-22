import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGateway } from "./gateway.js";
import type { Channel, ChannelInfo, ChannelStatus, InboundMessage, OutboundMessage } from "./types.js";

// --- Helpers ---

class FakeChannel implements Channel {
  name: string;
  description: string;
  started = false;
  stopped = false;
  sent: OutboundMessage[] = [];
  private statusValue: ChannelStatus = "stopped";
  sink: ((msg: InboundMessage) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    this.description = `channel ${name}`;
  }

  start(onMessage: (msg: InboundMessage) => void): void {
    this.sink = onMessage;
    this.started = true;
    this.statusValue = "running";
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.statusValue = "stopped";
  }
  async send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
  }
  status(): ChannelInfo {
    return { name: this.name, description: this.description, status: this.statusValue };
  }
}

function makeInbound(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: "m1",
    channel: "web",
    sender: "alice",
    text: "hello",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeGateway(...channels: Channel[]): { gateway: ChannelGateway; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "kda-gateway-"));
  const gateway = new ChannelGateway(cwd);
  for (const c of channels) gateway.register(c);
  return { gateway, cwd };
}

// --- Subject ---

describe("ChannelGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers and lists channels with live status", () => {
    const web = new FakeChannel("web");
    const { gateway } = makeGateway(web);
    expect(gateway.list()).toEqual([
      { name: "web", description: "channel web", status: "stopped" },
    ]);
    void gateway.start("web");
    expect(gateway.list()[0].status).toBe("running");
  });

  it("start returns error for unknown channel and hints at existing", () => {
    const { gateway } = makeGateway(new FakeChannel("web"));
    const err = gateway.start("nope");
    expect(err).toContain('Channel "nope" not found.');
    expect(err).toContain("Existing: web.");
  });

  it("start guards against double start", () => {
    const { gateway } = makeGateway(new FakeChannel("web"));
    expect(gateway.start("web")).toBeUndefined();
    expect(gateway.start("web")).toContain("already running");
  });

  it("inbound messages flow to the consumer set via setOnInbound", () => {
    const web = new FakeChannel("web");
    const { gateway } = makeGateway(web);
    const received: InboundMessage[] = [];
    gateway.setOnInbound((msg) => received.push(msg));
    void gateway.start("web");

    web.sink!(makeInbound());
    expect(received).toEqual([makeInbound()]);
  });

  it("inbound without consumer warns instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const web = new FakeChannel("web");
    const { gateway } = makeGateway(web);
    void gateway.start("web");

    web.sink!(makeInbound());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("reply routes through the source channel's send with replyTo id", async () => {
    const web = new FakeChannel("web");
    const { gateway } = makeGateway(web);

    await gateway.reply("the answer", makeInbound({ id: "abc", channel: "web" }));
    expect(web.sent).toHaveLength(1);
    expect(web.sent[0].text).toBe("the answer");
    expect(web.sent[0].replyTo).toBe("abc");
    expect(web.sent[0].channel).toBe("web");
  });

  it("reply to unknown channel never rejects", async () => {
    const { gateway } = makeGateway();
    await expect(gateway.reply("x", makeInbound({ channel: "ghost" }))).resolves.toBeUndefined();
  });

  it("reply isolates channel.send failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad: Channel = {
      ...new FakeChannel("bad"),
      send: () => Promise.reject(new Error("boom")),
    };
    const { gateway } = makeGateway(bad);
    await expect(gateway.reply("x", makeInbound({ channel: "bad" }))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("stop guards unknown and not-running; stopAll stops everything", async () => {
    const web = new FakeChannel("web");
    const im = new FakeChannel("im");
    const { gateway } = makeGateway(web, im);

    expect(gateway.stop("ghost")).toContain("not found");
    expect(gateway.stop("web")).toContain("not running");

    void gateway.start("web");
    void gateway.start("im");
    expect(gateway.stop("web")).toBeUndefined();
    expect(web.stopped).toBe(true);

    await gateway.stopAll();
    expect(web.stopped).toBe(true);
    expect(im.stopped).toBe(true);
  });
});
