import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { jsonSchema } from "ai";
import type { Tool, ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// McpConnection: manages a single MCP server subprocess
// ---------------------------------------------------------------------------

export class McpConnection {
  private proc: ChildProcess;
  private idCounter = 0;
  private pending = new Map<number, {
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private rl: readline.Interface;

  private constructor(proc: ChildProcess) {
    this.proc = proc;

    this.rl = readline.createInterface({
      input: proc.stdout!,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    });
  }

  /** Spawn server process and perform initialize handshake */
  static async connect(config: McpServerConfig): Promise<McpConnection> {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`Failed to create stdio streams for MCP server "${config.name}"`);
    }

    const conn = new McpConnection(proc);

    // Log stderr from server process
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[mcp:${config.name}] ${data.toString()}`);
    });

    proc.on("error", (err) => {
      throw new Error(`MCP server "${config.name}" failed to start: ${err.message}`);
    });

    // Initialize handshake
    const initResp = await conn.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "kda", version: "0.1.0" },
    });

    if (initResp.error) {
      conn.close();
      throw new Error(`MCP initialize failed for "${config.name}": ${initResp.error.message}`);
    }

    // Send initialized notification (no response expected)
    conn.notify("notifications/initialized");

    return conn;
  }

  /** Send a JSON-RPC request and wait for response */
  send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = ++this.idCounter;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  /** Close the server process */
  close(): void {
    this.rl.close();
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// McpClient: connects to MCP servers and bridges tools into ToolRegistry
// ---------------------------------------------------------------------------

export class McpClient {
  private connections: McpConnection[] = [];

  /** Connect to a single MCP server and return its tools as Tool[] */
  async connect(config: McpServerConfig): Promise<Tool[]> {
    const conn = await McpConnection.connect(config);
    this.connections.push(conn);

    const resp = await conn.send("tools/list");
    if (resp.error) {
      throw new Error(`tools/list failed for "${config.name}": ${resp.error.message}`);
    }

    const result = resp.result as { tools?: McpToolDefinition[] };
    const tools = result.tools ?? [];

    return tools.map((def) => this.adaptTool(conn, config.name, def));
  }

  /** Connect to multiple MCP servers and return all tools */
  async connectAll(configs: McpServerConfig[]): Promise<Tool[]> {
    const allTools: Tool[] = [];
    for (const config of configs) {
      try {
        const tools = await this.connect(config);
        allTools.push(...tools);
      } catch (err) {
        const e = err as Error;
        process.stderr.write(`[mcp] Failed to connect "${config.name}": ${e.message}\n`);
      }
    }
    return allTools;
  }

  /** Close all connections */
  close(): void {
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
  }

  /** Adapt an MCP tool definition to the internal Tool interface */
  private adaptTool(conn: McpConnection, serverName: string, def: McpToolDefinition): Tool {
    const mcpName = `mcp__${serverName}__${def.name}`;
    return {
      name: mcpName,
      description: def.description ?? "",
      parameters: jsonSchema(def.inputSchema),
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
        const resp = await conn.send("tools/call", {
          name: def.name,
          arguments: args,
        });

        if (resp.error) {
          return `Error: MCP tool "${def.name}" failed: ${resp.error.message}`;
        }

        const result = resp.result as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };

        if (result.content) {
          const texts = result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!);
          if (texts.length) return texts.join("\n");
        }

        return JSON.stringify(result, null, 2);
      },
      readOnly: true,
      parallelizable: true,
    };
  }
}
