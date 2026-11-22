import { describe, it, expect, afterEach, vi } from "vitest";
import { get as httpGet } from "node:http";
import { createWebChannel, DEFAULT_WEB_CHANNEL_PORT, MAX_INBOUND_TEXT_CHARS } from "./index.js";
import type { Channel, InboundMessage } from "../types.js";

// --- Helpers ---

/** 轮询等待条件成立（监听是异步的） */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function base(channel: Channel): string {
  const detail = channel.status().detail;
  if (!detail) throw new Error("no detail — channel not started");
  return detail;
}

function post(channel: Channel, body: unknown): Promise<Response> {
  return fetch(base(channel) + "/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 打开 SSE 连接，返回事件累积数组与关闭函数 */
function openSSE(url: string): { events: Record<string, unknown>[]; close: () => void } {
  const u = new URL(url);
  const events: Record<string, unknown>[] = [];
  const req = httpGet({ host: u.hostname, port: Number(u.port), path: u.pathname }, (res) => {
    res.setEncoding("utf-8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
      }
    });
  });
  return { events, close: () => req.destroy() };
}

// --- Subject ---

describe("web channel", () => {
  let channels: Channel[] = [];

  afterEach(async () => {
    // 必须停掉 server，否则 open handle 会让 vitest 挂死
    for (const c of channels) await c.stop();
    channels = [];
    vi.restoreAllMocks();
  });

  function track(channel: Channel): Channel {
    channels.push(channel);
    return channel;
  }

  it("defaults to port 8787 and starts in stopped state", () => {
    expect(DEFAULT_WEB_CHANNEL_PORT).toBe(8787);
    expect(createWebChannel().status()).toMatchObject({ name: "web", status: "stopped" });
  });

  it("serves the embedded chat page at GET /", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    channel.start(() => {});
    await waitFor(() => channel.status().status === "running");

    const res = await fetch(base(channel) + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("kda · web channel");
    expect(html).toContain("/api/messages");
  });

  it("accepts POST /api/messages and forwards to the sink (trim + id echo)", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    const inbound: InboundMessage[] = [];
    channel.start((m) => inbound.push(m));
    await waitFor(() => channel.status().status === "running");

    const res = await post(channel, { text: "  hello agent  ", sender: "alice" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; id: string };
    expect(data.ok).toBe(true);

    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toMatchObject({
      channel: "web",
      sender: "alice",
      text: "hello agent", // trim
    });
    expect(inbound[0].id).toBe(data.id);
  });

  it("defaults sender to web-user and truncates over-long sender", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    const inbound: InboundMessage[] = [];
    channel.start((m) => inbound.push(m));
    await waitFor(() => channel.status().status === "running");

    await post(channel, { text: "hi" });
    await post(channel, { text: "hi again", sender: "x".repeat(100) });
    await waitFor(() => inbound.length >= 2);
    expect(inbound[0].sender).toBe("web-user");
    expect(inbound[1].sender).toHaveLength(64);
    expect(inbound[1].sender).toMatch(/^x+$/);
  });

  it("rejects bad payloads with 400 and unknown routes with 404", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    channel.start(() => {});
    await waitFor(() => channel.status().status === "running");

    expect((await post(channel, "not json")).status).toBe(400);
    expect((await post(channel, { text: "   " })).status).toBe(400);
    expect((await post(channel, { text: "x".repeat(MAX_INBOUND_TEXT_CHARS + 1) })).status).toBe(400);
    expect((await fetch(base(channel) + "/api/nope")).status).toBe(404);
  });

  it("broadcasts send() to SSE clients as data frames", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    channel.start(() => {});
    await waitFor(() => channel.status().status === "running");

    const sse = openSSE(base(channel) + "/api/events");
    await new Promise((r) => setTimeout(r, 100)); // 等 SSE 握手完成

    await channel.send({
      channel: "web",
      text: "the reply",
      timestamp: "2026-01-01T00:00:00.000Z",
      replyTo: "m1",
    });
    await waitFor(() => sse.events.length > 0);
    expect(sse.events[0]).toEqual({
      text: "the reply",
      timestamp: "2026-01-01T00:00:00.000Z",
      replyTo: "m1",
    });
    sse.close();
  });

  it("send with zero connected clients resolves as no-op", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    channel.start(() => {});
    await waitFor(() => channel.status().status === "running");
    await expect(
      channel.send({ channel: "web", text: "x", timestamp: "t" }),
    ).resolves.toBeUndefined();
  });

  it("stop closes the server and is idempotent; status returns to stopped", async () => {
    const channel = track(createWebChannel({ port: 0 }));
    channel.start(() => {});
    await waitFor(() => channel.status().status === "running");
    const url = base(channel);

    await channel.stop();
    expect(channel.status()).toMatchObject({ status: "stopped", detail: undefined });
    await expect(fetch(url + "/")).rejects.toThrow();
    await expect(channel.stop()).resolves.toBeUndefined(); // 幂等
  });

  it("records EADDRINUSE as error status instead of crashing", async () => {
    const a = track(createWebChannel({ port: 0 }));
    a.start(() => {});
    await waitFor(() => a.status().status === "running");
    const port = new URL(base(a)).port;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = track(createWebChannel({ port: Number(port) }));
    b.start(() => {});
    await waitFor(() => b.status().status === "error");
    expect(b.status().detail).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });
});
