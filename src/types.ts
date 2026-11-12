// Shared types for the Agent Core Service
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string; // bcrypt
  displayName: string;
  createdAt: string;
}

export interface UserPublic {
  id: string;
  username: string;
  displayName: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  /** Default model provider for this agent */
  defaultProvider?: string;
  /** Default model ID for this agent */
  defaultModel?: string;
  /** Default thinking level for this agent; overrides the system "off" default */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Allowed tool names —empty = read-only */
  allowedTools: string[];
  /** System prompt override (falls back to workspace agent.md) */
  systemPrompt?: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfig {
  name: string;
  displayName?: string;
  baseUrl: string;
  apiKey?: string;
  /** Custom headers to attach */
  headers?: Record<string, string>;
  models: ProviderModel[];
}

export interface ProviderModel {
  id: string;
  name: string;
  /** e.g. "openai" —omit to use provider default */
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** API compatibility overrides for non-standard OpenAI endpoints.
   *  e.g. { supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" } */
  compat?: Record<string, any>;
}

export interface ChatRequest {
  message: string;
  provider?: string;
  model?: string;
  /** Resume a specific session by ID */
  sessionId?: string;
  /** LLM thinking depth. "off" disables thinking; "low"/"medium"/"high" enable it. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ChatResponse {
  agentId: string;
  sessionId: string;
  reply: string;
  model: { provider: string; model: string };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentSessionRecord {
  agentId: string;
  userId: string;
  sessionId: string;
  messages: any[];
  createdAt: string;
}
