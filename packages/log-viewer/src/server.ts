import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLog } from "./parser.js";

const POLL_INTERVAL_MS = 1000;

export function startServer(logPath: string, port: number): void {
  const sseClients = new Set<ServerResponse>();
  let lastSize = existsSync(logPath) ? statSync(logPath).size : 0;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const htmlPath = resolve(__dirname, "..", "public", "index.html");

  // Poll for new log content and push to SSE clients
  setInterval(() => {
    if (!existsSync(logPath)) return;
    const stat = statSync(logPath);

    // Handle log truncation (file got smaller — log was cleared/recreated)
    if (stat.size < lastSize) {
      lastSize = 0;
    }
    if (stat.size <= lastSize) return;

    const fd = openSync(logPath, "r");
    const buf = Buffer.alloc(stat.size - lastSize);
    readSync(fd, buf, 0, buf.length, lastSize);
    closeSync(fd);
    lastSize = stat.size;

    const entries = parseLog(buf.toString("utf-8"));
    for (const entry of entries) {
      const data = `data: ${JSON.stringify(entry)}\n\n`;
      for (const client of sseClients) {
        client.write(data);
      }
    }
  }, POLL_INTERVAL_MS);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/") {
      try {
        const html = readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("index.html not found");
      }
      return;
    }

    if (url.pathname === "/api/logs") {
      try {
        const content = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
        const entries = parseLog(content);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    if (url.pathname === "/api/events") {
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

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`kda log viewer → http://localhost:${port}`);
    console.log(`watching: ${logPath}`);
  });
}
