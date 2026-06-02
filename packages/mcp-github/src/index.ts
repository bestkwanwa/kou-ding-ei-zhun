#!/usr/bin/env node

import readline from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-03-26";

const SERVER_INFO = {
  name: "kda-mcp-github",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_API = "https://api.github.com";

async function githubFetch(
  endpoint: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(endpoint, GITHUB_API);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  let resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30_000),
    headers,
  });

  // 401 with token → retry without auth (public endpoints still work)
  if (resp.status === 401 && GITHUB_TOKEN) {
    delete headers.Authorization;
    resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
      headers,
    });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `GitHub API ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
    );
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_issues",
    description:
      "List issues for a GitHub repository. Returns issue number, title, state, author, and creation time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: {
          type: "string",
          description: "Issue state filter",
          enum: ["open", "closed", "all"],
          default: "open",
        },
        per_page: {
          type: "number",
          description: "Results per page (max 100)",
          default: 10,
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "search_repositories",
    description:
      "Search GitHub repositories. Returns name, description, stars, language, and URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        per_page: {
          type: "number",
          description: "Results per page (max 100)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_file_contents",
    description:
      "Get file or directory contents from a GitHub repository. For files, returns decoded content. For directories, returns file listing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        path: {
          type: "string",
          description: "File or directory path",
          default: "README.md",
        },
      },
      required: ["owner", "repo"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<string>;

async function handleListIssues(args: Record<string, unknown>): Promise<string> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const state = (args.state as string) ?? "open";
  const perPage = String(args.per_page ?? 10);

  const data = (await githubFetch(`/repos/${owner}/${repo}/issues`, {
    state,
    per_page: perPage,
    sort: "created",
    direction: "desc",
  })) as Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string } | null;
    created_at: string;
    html_url: string;
    pull_request?: unknown;
  }>;

  // Filter out pull requests (GitHub API returns PRs in issues endpoint)
  const issues = data.filter((item) => !item.pull_request);

  if (issues.length === 0) {
    return `No ${state} issues found in ${owner}/${repo}.`;
  }

  const lines = issues.map(
    (issue) =>
      `#${issue.number} [${issue.state}] ${issue.title}\n` +
      `  Author: ${issue.user?.login ?? "unknown"} | Created: ${issue.created_at}\n` +
      `  ${issue.html_url}`,
  );

  return lines.join("\n\n");
}

async function handleSearchRepositories(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  const perPage = String(args.per_page ?? 10);

  const data = (await githubFetch("/search/repositories", {
    q: query,
    per_page: perPage,
    sort: "stars",
    order: "desc",
  })) as {
    total_count: number;
    items: Array<{
      full_name: string;
      description: string | null;
      stargazers_count: number;
      language: string | null;
      html_url: string;
    }>;
  };

  if (!data.items?.length) {
    return `No repositories found for "${query}".`;
  }

  const lines = data.items.map(
    (repo) =>
      `**${repo.full_name}** (⭐ ${repo.stargazers_count})\n` +
      `  ${repo.description ?? "No description"}\n` +
      `  Language: ${repo.language ?? "N/A"} | ${repo.html_url}`,
  );

  return `Found ${data.total_count} repositories (showing ${data.items.length}):\n\n${lines.join("\n\n")}`;
}

async function handleGetFileContents(
  args: Record<string, unknown>,
): Promise<string> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const filePath = (args.path as string) ?? "README.md";

  const data = (await githubFetch(
    `/repos/${owner}/${repo}/contents/${filePath}`,
  )) as unknown;

  // Directory listing: returns an array
  if (Array.isArray(data)) {
    const entries = data as Array<{
      name: string;
      type: string;
      size: number;
      path: string;
    }>;
    const lines = entries.map(
      (entry) =>
        `${entry.type === "dir" ? "📁" : "📄"} ${entry.name} (${entry.type}, ${entry.size} bytes)`,
    );
    return `Contents of ${filePath}:\n${lines.join("\n")}`;
  }

  // Single file: returns an object
  const file = data as {
    name: string;
    size: number;
    encoding: string;
    content: string;
  };

  if (file.encoding === "base64" && file.content) {
    const decoded = Buffer.from(file.content, "base64").toString("utf-8");
    // Truncate very large files
    const MAX_LENGTH = 50_000;
    if (decoded.length > MAX_LENGTH) {
      return (
        decoded.slice(0, MAX_LENGTH) +
        `\n\n... (truncated, file is ${file.size} bytes total)`
      );
    }
    return decoded;
  }

  return `File: ${file.name} (${file.size} bytes) — content not available in base64 encoding.`;
}

const HANDLERS: Record<string, ToolHandler> = {
  list_issues: handleListIssues,
  search_repositories: handleSearchRepositories,
  get_file_contents: handleGetFileContents,
};

// ---------------------------------------------------------------------------
// JSON-RPC message handling
// ---------------------------------------------------------------------------

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: number | string | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(
  id: number | string | null,
  code: number,
  message: string,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { method, params, id } = msg;

  switch (method) {
    case "initialize":
      sendResult(id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "ping":
      sendResult(id ?? null, {});
      break;

    case "tools/list":
      sendResult(id ?? null, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      const handler = HANDLERS[toolName];
      if (!handler) {
        send({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        });
        return;
      }

      try {
        const text = await handler(args);
        send({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [{ type: "text", text }],
            isError: false,
          },
        });
      } catch (err) {
        const e = err as Error;
        send({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          },
        });
      }
      break;
    }

    default:
      sendError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: undefined, // don't echo
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg = JSON.parse(trimmed) as JsonRpcRequest;
    await handleMessage(msg);
  } catch {
    sendError(null, -32700, "Parse error");
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Keep process alive
process.stdin.resume();
