import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentInput } from "./input.js";
import { ChannelGateway } from "../channels/index.js";
import { CronManager } from "../cron/index.js";
import type { Channel, ChannelInfo, ChannelStatus, InboundMessage } from "../channels/index.js";

// --- Helpers ---

class SinkChannel implements Channel {
  name = "fake";
  description = "fake";
  private statusValue: ChannelStatus = "stopped";
  sink: ((msg: InboundMessage) => void) | null = null;

  start(onMessage: (msg: InboundMessage) => void): void {
    this.sink = onMessage;
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

function makeInbound(text: string): InboundMessage {
  return {
    id: `id-${text}`,
    channel: "fake",
    sender: "alice",
    text,
    timestamp: new Date().toISOString(),
  };
}

// --- Subject ---

describe("createAgentInput (channel events via gateway wiring)", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function harness() {
    const cwd = mkdtempSync(join(tmpdir(), "kda-input-"));
    dirs.push(cwd);
    const gateway = new ChannelGateway(cwd);
    const channel = new SinkChannel();
    gateway.register(channel);
    const input = createAgentInput(gateway, undefined, { input: new PassThrough(), output: new PassThrough() });
    gateway.start("fake"); // createAgentInput 已接线 sink，此时启动渠道
    return { input, channel };
  }

  it("resolves a pending next() when a channel message arrives", async () => {
    const h = harness();
    const p = h.input.next();
    h.channel.sink!(makeInbound("from channel"));
    await expect(p).resolves.toMatchObject({ type: "channel", message: { text: "from channel" } });
  });

  it("queues events arriving before next() is called (FIFO)", async () => {
    const h = harness();
    h.channel.sink!(makeInbound("first"));
    h.channel.sink!(makeInbound("second"));
    await expect(h.input.next()).resolves.toMatchObject({ message: { text: "first" } });
    await expect(h.input.next()).resolves.toMatchObject({ message: { text: "second" } });
  });

  it("close resolves a pending waiter with the exit sentinel", async () => {
    const h = harness();
    const p = h.input.next();
    h.input.close();
    await expect(p).resolves.toEqual({ type: "terminal", line: "" });
  });

  it("returns the exit sentinel repeatedly after close (no hang)", async () => {
    const h = harness();
    h.input.close();
    await expect(h.input.next()).resolves.toEqual({ type: "terminal", line: "" });
    await expect(h.input.next()).resolves.toEqual({ type: "terminal", line: "" });
  });

  it("throws on concurrent next() (single consumer contract)", async () => {
    const h = harness();
    const p = h.input.next();
    try {
      h.input.next();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("concurrently");
    } finally {
      h.input.close();
      await p;
    }
  });
});

describe("createAgentInput (terminal lines via real streams)", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("buffers lines typed while busy, in order; EOF exits cleanly without hanging", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kda-input-stream-"));
    dirs.push(cwd);
    const stdinStream = new PassThrough();
    const input = createAgentInput(new ChannelGateway(cwd), undefined, {
      input: stdinStream,
      output: new PassThrough(),
    });

    // 模拟“agent 回合进行中”用户连打两行：next() 未调用时先入队（line 事件不带换行符）
    stdinStream.write("during turn 1\n");
    stdinStream.write("during turn 2\n");
    await expect(input.next()).resolves.toEqual({ type: "terminal", line: "during turn 1" });
    await expect(input.next()).resolves.toEqual({ type: "terminal", line: "during turn 2" });

    // EOF（管道 stdin 结束）→ 空 terminal 事件 = 退出哨兵，且重复调用不挂死
    stdinStream.end();
    await expect(input.next()).resolves.toEqual({ type: "terminal", line: "" });
    await expect(input.next()).resolves.toEqual({ type: "terminal", line: "" });
    input.close();
  });

  it("prompt() writes the prompt to the output stream", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kda-input-prompt-"));
    dirs.push(cwd);
    const stdoutStream = new PassThrough();
    const input = createAgentInput(undefined, undefined, { input: new PassThrough(), output: stdoutStream });

    input.prompt();
    const chunk = await new Promise<string>((resolve) => {
      stdoutStream.once("data", (c) => resolve(c.toString()));
    });
    expect(chunk).toContain("> ");
    input.close();
  });
});

describe("createAgentInput (cron due events via manager wiring)", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("delivers cron triggers through the same FIFO", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kda-input-cron-"));
    dirs.push(cwd);
    let t = 1_700_000_000_000;
    const cron = new CronManager(cwd, { now: () => new Date(t) });
    const input = createAgentInput(undefined, cron, { input: new PassThrough(), output: new PassThrough() });
    cron.addTask({
      kind: "bash",
      schedule: { type: "interval", ms: 60_000 },
      scheduleExpr: "every 60s",
      payload: "echo x",
    });

    const p = input.next(); // 先挂起等待，再触发：验证到点事件唤醒消费者
    t += 61_000;
    cron.runDueChecks(new Date(t));
    await expect(p).resolves.toMatchObject({ type: "cron", trigger: { kind: "bash", payload: "echo x" } });
    input.close();
  });
});
