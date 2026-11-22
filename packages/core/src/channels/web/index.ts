import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Channel, ChannelInfo, InboundMessage, OutboundMessage } from "../types.js";
import { WEB_PAGE_HTML } from "./web-page.js";

export const DEFAULT_WEB_CHANNEL_PORT = 8787; // 8080=preview、9527=log-viewer 均已占用
export const MAX_INBOUND_TEXT_CHARS = 4000;
export const MAX_SENDER_CHARS = 64;
const MAX_BODY_BYTES = 64 * 1024;

export interface WebChannelOptions {
  /** 0 = 随机端口（测试用）；缺省取 KDA_CHANNEL_PORT env，再缺省 8787 */
  port?: number;
  /** 默认 127.0.0.1 —— v1 只绑本地，不暴露 LAN */
  host?: string;
}

/**
 * web channel：本地聊天测试页（node:http + SSE，零依赖，仿 log-viewer）。
 * 入站 POST /api/messages → onMessage sink；出站 send() → SSE 广播给全部已连接页面。
 */
export function createWebChannel(options?: WebChannelOptions): Channel {
  const port = options?.port ?? (Number(process.env.KDA_CHANNEL_PORT) || DEFAULT_WEB_CHANNEL_PORT);
  const host = options?.host ?? "127.0.0.1";

  let sink: ((msg: InboundMessage) => void) | null = null;
  let server: Server | null = null;
  const sseClients = new Set<ServerResponse>();
  let info: ChannelInfo = {
    name: "web",
    description: "Local browser chat test page",
    status: "stopped",
  };

  async function handleRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WEB_PAGE_HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const raw = await readBody(req);
      if (raw === null) {
        json(res, 400, { error: "payload too large" });
        return;
      }
      let parsed: { text?: unknown; sender?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "invalid JSON" });
        return;
      }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text) {
        json(res, 400, { error: "text must be a non-empty string" });
        return;
      }
      if (text.length > MAX_INBOUND_TEXT_CHARS) {
        json(res, 400, { error: "text too long (max 4000 chars)" });
        return;
      }
      const sender = (typeof parsed.sender === "string" && parsed.sender.trim()
        ? parsed.sender.trim()
        : "web-user"
      ).slice(0, MAX_SENDER_CHARS);
      if (!sink) {
        json(res, 503, { error: "channel not started" });
        return;
      }
      const msg: InboundMessage = {
        id: randomUUID(),
        channel: "web",
        sender,
        text,
        timestamp: new Date().toISOString(),
      };
      sink(msg);
      json(res, 200, { ok: true, id: msg.id });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  return {
    name: "web",
    description: info.description,

    start(onMessage) {
      if (info.status === "running" || info.status === "starting") return;
      sink = onMessage;
      info = { ...info, status: "starting", detail: `http://${host}:${port}` };
      server = createServer((req, res) => {
        void handleRoute(req, res).catch(() => {
          if (!res.writableEnded) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal error");
          }
        });
      });
      // error 监听必须先于 listen：EADDRINUSE 是异步到达的 'error' 事件，不挂 handler 会崩进程
      server.on("error", (err) => {
        info = { ...info, status: "error", detail: err.message };
        console.warn(`Channel "web" failed: ${err.message}`);
      });
      server.listen(port, host, () => {
        const addr = server?.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        info = { ...info, status: "running", detail: `http://${host}:${actualPort}` };
      });
    },

    async stop() {
      if (info.status === "stopped") return;
      for (const res of sseClients) {
        res.end();
      }
      sseClients.clear();
      const s = server;
      server = null;
      info = { ...info, status: "stopped", detail: undefined };
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    },

    async send(out: OutboundMessage) {
      const frame =
        "data: " +
        JSON.stringify({ text: out.text, timestamp: out.timestamp, replyTo: out.replyTo ?? null }) +
        "\n\n";
      for (const res of sseClients) {
        if (!res.writableEnded) res.write(frame);
      }
    },

    status() {
      return { ...info };
    },
  };
}

/** 读取请求体，超过 MAX_BODY_BYTES 返回 null */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function json(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
