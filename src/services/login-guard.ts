import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

interface FailureRecord {
  /** Timestamps of recent failures within the rate window. */
  times: number[];
  /** Epoch ms until which the key is locked; 0 = not locked. */
  lockedUntil: number;
}

/**
 * In-memory login brute-force guard. Keys are "ip + username" so a legitimate
 * user's failed typing does not block other users on the same IP, and an
 * attacker cannot keep trying one account from many IPs without tripping the
 * per-account lockout as well.
 *
 * NOTE: state lives in this process. For a multi-instance deployment this
 * should be swapped for a shared store (Redis) — see docs.
 */
class LoginGuard {
  private store = new Map<string, FailureRecord>();
  private lastCleanup = 0;

  private key(ip: string, username: string): string {
    // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4) so the same
    // client is keyed consistently regardless of how Express reports it.
    const normalizedIp = (ip || "unknown").replace(/^::ffff:/, "");
    return `${normalizedIp}\u0000${username.toLowerCase()}`;
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;
    const windowMs = config.loginRateWindowMs;
    for (const [k, rec] of this.store) {
      rec.times = rec.times.filter((t) => now - t < windowMs);
      if (rec.times.length === 0 && rec.lockedUntil <= now) this.store.delete(k);
    }
  }

  isLocked(ip: string, username: string): boolean {
    const now = Date.now();
    this.cleanup(now);
    const rec = this.store.get(this.key(ip, username));
    if (!rec) return false;
    if (rec.lockedUntil > now) return true;
    if (rec.lockedUntil > 0) {
      // Lock expired: reset the counter so the user can try again.
      rec.lockedUntil = 0;
      rec.times = [];
    }
    return false;
  }

  lockRemainingMs(ip: string, username: string): number {
    const rec = this.store.get(this.key(ip, username));
    if (!rec) return 0;
    return Math.max(0, rec.lockedUntil - Date.now());
  }

  recordFailure(ip: string, username: string): void {
    const now = Date.now();
    const k = this.key(ip, username);
    const windowMs = config.loginRateWindowMs;
    this.cleanup(now);
    let rec = this.store.get(k);
    if (!rec) {
      rec = { times: [], lockedUntil: 0 };
      this.store.set(k, rec);
    }
    rec.times = rec.times.filter((t) => now - t < windowMs);
    rec.times.push(now);
    if (rec.times.length >= config.loginMaxAttempts) {
      rec.lockedUntil = now + config.loginLockoutMs;
      rec.times = [];
      log.warn(
        `login lockout triggered ip=${ip} username=${username} for ${Math.round(config.loginLockoutMs / 1000)}s`,
      );
    }
  }

  reset(ip: string, username: string): void {
    this.store.delete(this.key(ip, username));
  }

  remainingAttempts(ip: string, username: string): number {
    const now = Date.now();
    const rec = this.store.get(this.key(ip, username));
    if (!rec || rec.lockedUntil > now) return config.loginMaxAttempts;
    const recent = rec.times.filter((t) => now - t < config.loginRateWindowMs).length;
    return Math.max(0, config.loginMaxAttempts - recent);
  }

  /** Only used by tests to reset global state. */
  clear(): void {
    this.store.clear();
  }
}

export const loginGuard = new LoginGuard();
