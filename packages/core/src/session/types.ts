import type { ModelMessage } from "ai";

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messages: ModelMessage[];
  discoveredTools: string[];
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messageCount: number;
}
