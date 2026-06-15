import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { SessionData, SessionMetadata } from "./types.js";

interface MetaLine {
  type: "meta";
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  discoveredTools: string[];
}

interface MessageLine {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

export class SessionStore {
  constructor(private cwd: string) {}

  private get dir(): string {
    return resolve(this.cwd, ".kda", "sessions");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private sessionPath(id: string): string {
    return resolve(this.dir, `${id}.jsonl`);
  }

  /**
   * Save session as JSONL. Preserves existing message lines (with their
   * original timestamps) and only wraps newly added messages.
   *
   * Line 1: {"type":"meta", ...}
   * Line 2+: {"type":"message","timestamp":"...","message":{...}}
   */
  save(data: SessionData): void {
    this.ensureDir();
    const path = this.sessionPath(data.id);

    // Read existing message lines to preserve timestamps
    let existingMsgLines: string[] = [];
    try {
      const raw = readFileSync(path, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const first = JSON.parse(lines[0]);
        if (first.type === "meta") {
          existingMsgLines = lines.slice(1);
        }
      }
    } catch {
      // new file
    }

    // If history shrank (shouldn't happen normally), full rewrite
    if (data.messages.length < existingMsgLines.length) {
      existingMsgLines = [];
    }

    const meta: MetaLine = {
      type: "meta",
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      summary: data.summary,
      discoveredTools: data.discoveredTools,
    };

    // Only wrap new messages (beyond existing count) with fresh timestamps
    const newMessages = data.messages.slice(existingMsgLines.length);
    const now = data.updatedAt;
    const newMsgLines = newMessages.map((m) =>
      JSON.stringify({ type: "message", timestamp: now, message: m } as MessageLine),
    );

    const allLines = [JSON.stringify(meta), ...existingMsgLines, ...newMsgLines];
    writeFileSync(path, allLines.join("\n") + "\n", "utf-8");
  }

  /** Load session from JSONL file */
  load(id: string): SessionData | null {
    try {
      const raw = readFileSync(this.sessionPath(id), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return null;

      const meta = JSON.parse(lines[0]) as MetaLine;
      const messages: ModelMessage[] = [];
      for (const line of lines.slice(1)) {
        const entry = JSON.parse(line);
        if (entry.type === "message") {
          messages.push(entry.message as ModelMessage);
        }
      }

      return {
        id: meta.id,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        summary: meta.summary,
        messages,
        discoveredTools: meta.discoveredTools,
      };
    } catch {
      return null;
    }
  }

  /** List all sessions, sorted by updatedAt descending */
  list(): SessionMetadata[] {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
      const sessions: SessionMetadata[] = files.map((f) => {
        const raw = readFileSync(resolve(this.dir, f), "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const meta = JSON.parse(lines[0]) as MetaLine;
        const messageCount = lines
          .slice(1)
          .filter((l) => {
            try {
              return JSON.parse(l).type === "message";
            } catch {
              return false;
            }
          }).length;
        return {
          id: meta.id,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          summary: meta.summary,
          messageCount,
        };
      });
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sessions;
    } catch {
      return [];
    }
  }

  latest(): SessionMetadata | null {
    const sessions = this.list();
    return sessions.length > 0 ? sessions[0] : null;
  }

  create(firstPrompt: string): SessionData {
    const now = new Date().toISOString();
    const summary = firstPrompt.trim().slice(0, 80) || "(empty)";
    return {
      id: randomUUID().slice(0, 8),
      createdAt: now,
      updatedAt: now,
      summary,
      messages: [],
      discoveredTools: [],
    };
  }
}
