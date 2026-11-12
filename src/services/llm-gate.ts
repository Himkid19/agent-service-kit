import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("gate");

/**
 * Concurrency gate for LLM prompt execution.
 *
 * `MAX_CONCURRENT_LLM_CALLS` existed in config but was never enforced: any
 * number of requests could simultaneously hold a full AgentSession (all
 * messages + tool results) plus an active provider stream, multiplying peak
 * memory. The gate bounds concurrent prompts; additional callers queue up to
 * `LLM_QUEUE_TIMEOUT_MS`, then fail fast with a clear error.
 */
export interface LlmGateStats {
  limit: number;
  active: number;
  waiting: number;
  totalRejected: number;
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class LlmGate {
  private active = 0;
  private waiters: Waiter[] = [];
  private totalRejected = 0;

  constructor(
    private readonly limit: number,
    private readonly queueTimeoutMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        this.totalRejected++;
        log.warn(
          `LLM concurrency queue exceeded ${Math.round(this.queueTimeoutMs / 1000)}s (waiting=${this.waiters.length} active=${this.limit}) — rejecting request`,
        );
        reject(new Error("LLM_CALL_QUEUE_TIMEOUT"));
      }, this.queueTimeoutMs);
      this.waiters.push({ resolve, timer });
    });
    // Slot ownership was transferred by release(); do not increment here.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the oldest waiter: `active` stays at `limit`
      // (ownership transfer, not a new grant) and the waiter's timer is
      // cancelled so it can never reject after taking the slot.
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  stats(): LlmGateStats {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiters.length,
      totalRejected: this.totalRejected,
    };
  }
}

export const llmGate = new LlmGate(config.maxConcurrentLlmCalls, config.llmQueueTimeoutMs);
