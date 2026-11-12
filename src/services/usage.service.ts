import { type ContextUsage } from "@earendil-works/pi-coding-agent";
import { config } from "../config.js";
import type { TokenUsage, ContextUsageSnapshot } from "../types.js";

export type { TokenUsage, ContextUsageSnapshot } from "../types.js";

export interface SessionUsage {
  usage: TokenUsage;
  contextUsage: ContextUsageSnapshot | null;
}

export function extractUsage(session: { getSessionStats?: () => any; getContextUsage?: () => ContextUsage | undefined }): SessionUsage | undefined {
  const stats = session.getSessionStats?.();
  const ctx = session.getContextUsage?.();
  if (!stats) return undefined;
  return {
    usage: {
      inputTokens: stats.tokens?.input ?? 0,
      outputTokens: stats.tokens?.output ?? 0,
      cacheReadTokens: stats.tokens?.cacheRead ?? 0,
      cacheWriteTokens: stats.tokens?.cacheWrite ?? 0,
      totalTokens: stats.tokens?.total ?? 0,
      cost: stats.cost ?? 0,
    },
    contextUsage: ctx
      ? {
          tokens: ctx.tokens ?? null,
          contextWindow: ctx.contextWindow ?? 0,
          percent: ctx.percent ?? null,
        }
      : null,
  };
}

export function isContextLimitReached(contextUsage: ContextUsageSnapshot | null): boolean {
  if (!contextUsage) return false;
  if (contextUsage.percent == null) return false;
  return contextUsage.percent >= config.contextLimitPercent;
}

export function contextLimitMessage(contextUsage: ContextUsageSnapshot): string {
  const tokens = contextUsage.tokens ?? "unknown";
  return `Context window limit reached: ${tokens}/${contextUsage.contextWindow} tokens (${contextUsage.percent}%). Start a new session to continue.`;
}
