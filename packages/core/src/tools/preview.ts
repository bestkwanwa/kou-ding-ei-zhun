import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { jsonSchema } from "ai";
import type { Tool, ToolContext } from "./types.js";
import { createScaffold } from "./scaffold.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

/** Track running server so repeated calls reuse it */
let server: http.Server | null = null;

function serveDir(dir: string, port: number, ctx: ToolContext): Promise<string> {
  // Reuse already running server
  if (server) {
    return Promise.resolve(`Preview server already running at http://localhost:${port}`);
  }

  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const urlPath = req.url?.split("?")[0] ?? "/";
      let filePath = path.join(dir, urlPath);

      // Serve index.html for directories
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(filePath, "index.html");
        }
      } catch {
        // fall through — will 404 below
      }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      server = null;
      if (err.code === "EADDRINUSE") {
        resolve(`Error: port ${port} is already in use. Try stopping the existing process or using a different port.`);
      } else {
        resolve(`Error: failed to start server: ${err.message}`);
      }
    });

    server.listen(port, () => {
      resolve(`Preview server started at http://localhost:${port} (serving ${path.relative(ctx.cwd, dir) || "app/"})`);
    });
  });
}

export const previewTool: Tool = {
  name: "preview",
  description:
    "Scaffold and serve a React+TSX app at http://localhost:8080 — call this to instantly bootstrap a working React project with hot reload. " +
    "It auto-creates index.html, App.tsx, and build config, then starts a preview server. " +
    "You only need to write app/Main.tsx with your component as default export. " +
    "Do NOT manually create index.html, App.tsx, or any build config.",
  parameters: jsonSchema({
    type: "object",
    properties: {},
  }),
  async execute(_args, ctx) {
    const dir = path.resolve(ctx.cwd, "app");
    const port = 8080;

    // Ensure scaffold exists — index.html is always managed by the tool
    createScaffold(dir);

    return serveDir(dir, port, ctx);
  },
  maxResultLength: 1_000,
  lazy: true,
  hint: "preview react tsx component browser server localhost render ui page app",
};
