import type { ModelMessage } from "ai";

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messages: ModelMessage[];
  discoveredTools: string[];
  /** 会话内已激活的 skill slug（与 discoveredTools 对称流动） */
  loadedSkills: string[];
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messageCount: number;
}
