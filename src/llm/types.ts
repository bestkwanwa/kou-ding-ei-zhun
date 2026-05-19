// LLM layer will be handled by Vercel AI SDK.
// Types here are placeholders and will be replaced by AI SDK types.

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMResponse {
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
