/**
 * Bounded session cache with TTL + LRU eviction.
 *
 * Replaces the previously unbounded `Map<string, ActiveSession>` in
 * ChatService: every (userId, agentId, sessionId) combination used to stay in
 * memory forever (each entry holds a full Pi AgentSession with all messages
 * and tool results), which made RSS grow monotonically on a long-running
 * server until the host ran out of memory.
 */
export interface SessionCacheOptions<V> {
  /** Entries idle longer than this are evicted by sweep(). */
  ttlMs: number;
  /** Hard cap; inserting beyond this evicts the least-recently-used entry. */
  capacity: number;
  /** Release resources held by a value when it is evicted/deleted/cleared. */
  dispose?: (value: V) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  /** Epoch ms of last access — TTL baseline and LRU rank (Map order). */
  lastUsedAt: number;
}

export interface SessionCacheStats {
  size: number;
  capacity: number;
  ttlMs: number;
  /** Total entries disposed because their idle time exceeded the TTL. */
  evictedIdle: number;
  /** Total entries disposed to make room (LRU) or by disposeAll. */
  evictedOther: number;
}

export class SessionCache<V> {
  private map = new Map<string, Entry<V>>();
  private evictedIdle = 0;
  private evictedOther = 0;

  constructor(private readonly options: SessionCacheOptions<V>) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error("SessionCache: ttlMs must be > 0");
    if (!Number.isFinite(options.capacity) || options.capacity < 1) throw new Error("SessionCache: capacity must be >= 1");
  }

  private time(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Get a value and refresh its TTL/LRU position. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.time() - entry.lastUsedAt > this.options.ttlMs) {
      this.remove(key);
      return undefined;
    }
    // Re-insert to move the entry to the end of the Map (MRU side).
    this.map.delete(key);
    entry.lastUsedAt = this.time();
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      existing.value = value;
      existing.lastUsedAt = this.time();
      this.map.set(key, existing);
      return;
    }
    while (this.map.size >= this.options.capacity) {
      // First key of a Map is the least-recently-used entry.
      const lruKey = this.map.keys().next().value as string;
      this.remove(lruKey);
      this.evictedOther++;
    }
    this.map.set(key, { value, lastUsedAt: this.time() });
  }

  /** Delete a key, disposing its value. Returns true when the key existed. */
  delete(key: string): boolean {
    return this.remove(key);
  }

  /** Remove and dispose every entry whose idle time exceeds the TTL. */
  sweep(): number {
    const now = this.time();
    for (const [key, entry] of this.map) {
      if (now - entry.lastUsedAt > this.options.ttlMs) {
        this.remove(key);
        this.evictedIdle++;
      }
    }
    return this.evictedIdle;
  }

  disposeAll(): number {
    const count = this.map.size;
    for (const [key] of this.map) {
      this.remove(key);
      this.evictedOther++;
    }
    return count;
  }

  /** Delete every entry whose key satisfies the predicate (dispose included). */
  deleteWhere(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) {
        this.remove(key);
        this.evictedOther++;
        removed++;
      }
    }
    return removed;
  }

  remove(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    try {
      this.options.dispose?.(entry.value);
    } catch {
      // Dispose errors must not break eviction.
    }
    return true;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): SessionCacheStats {
    return {
      size: this.map.size,
      capacity: this.options.capacity,
      ttlMs: this.options.ttlMs,
      evictedIdle: this.evictedIdle,
      evictedOther: this.evictedOther,
    };
  }
}
