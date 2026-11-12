import { db } from "../db.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("heartbeat");

export interface HeartbeatStatus {
  /** Last heartbeat result: "ok" | "fail" | null before the first run. */
  lastStatus: "ok" | "fail" | null;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalBeats: number;
  startedAt: string | null;
}

class HealthService {
  private timer: NodeJS.Timeout | null = null;
  private status: HeartbeatStatus = {
    lastStatus: null,
    lastLatencyMs: null,
    lastCheckedAt: null,
    lastError: null,
    consecutiveFailures: 0,
    totalBeats: 0,
    startedAt: null,
  };

  /** Start the periodic DB heartbeat. Safe to call once at server startup. */
  start(): void {
    if (this.timer) return;
    this.status.startedAt = new Date().toISOString();
    // Run one beat immediately so /api/health/ready is meaningful right away.
    void this.beat();
    this.timer = setInterval(() => void this.beat(), config.heartbeatIntervalMs);
    this.timer.unref();
    log.info(`heartbeat started (interval ${config.heartbeatIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("heartbeat stopped");
    }
  }

  getStatus(): HeartbeatStatus {
    return { ...this.status };
  }

  /** One heartbeat: ping the DB, record latency, log on failure/recovery. */
  private async beat(): Promise<void> {
    try {
      const latencyMs = await db.ping(Math.min(5000, config.heartbeatIntervalMs));
      const recovered = this.status.consecutiveFailures > 0;
      this.status.lastStatus = "ok";
      this.status.lastLatencyMs = latencyMs;
      this.status.lastCheckedAt = new Date().toISOString();
      this.status.lastError = null;
      this.status.consecutiveFailures = 0;
      this.status.totalBeats++;
      if (recovered) {
        log.info(`db recovered, ping ${latencyMs}ms`);
      } else {
        log.debug(`db ping ok (${latencyMs}ms)`);
      }
    } catch (err: any) {
      this.status.lastStatus = "fail";
      this.status.lastCheckedAt = new Date().toISOString();
      this.status.lastError = err?.message ?? String(err);
      this.status.consecutiveFailures++;
      this.status.totalBeats++;
      log.error(`db ping FAILED (${this.status.consecutiveFailures} consecutive)`, this.status.lastError);
    }
  }
}

export const healthService = new HealthService();
