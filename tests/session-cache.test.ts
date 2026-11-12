import { describe, it, expect } from "vitest";
import { SessionCache } from "../src/services/session-cache.js";

/** Deterministic clock so TTL/LRU behaviour is fully controlled in tests. */
let nowMs = 1_000_000;
const tick = (ms: number) => { nowMs += ms; };

describe("SessionCache", () => {
  it("stores, gets, and touches entries", () => {
    const cache = new SessionCache<string>({ ttlMs: 1000, capacity: 3, now: () => nowMs });
    cache.set("a", "A");
    expect(cache.get("a")).toBe("A");
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(true);
  });

  it("evicts entries whose idle time exceeds the TTL on get()", () => {
    const cache = new SessionCache<string>({ ttlMs: 1000, capacity: 3, now: () => nowMs });
    cache.set("a", "A");
    tick(1001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("sweeps only idle entries and counts them", () => {
    const cache = new SessionCache<string>({ ttlMs: 1000, capacity: 5, now: () => nowMs });
    cache.set("a", "A");
    tick(700);
    cache.set("b", "B");
    tick(700); // a idle 1400 (> ttl), b idle 700 (< ttl)
    const evicted = cache.sweep();
    expect(evicted).toBeGreaterThan(0);
    expect(cache.stats().evictedIdle).toBe(1);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("a")).toBe(false);
  });

  it("evicts the least-recently-used entry when capacity is reached", () => {
    const cache = new SessionCache<string>({ ttlMs: 10_000, capacity: 2, now: () => nowMs });
    cache.set("a", "A");
    tick(10);
    cache.set("b", "B");
    tick(10);
    cache.get("a"); // touch a: b becomes the LRU entry
    tick(10);
    cache.set("c", "C"); // must evict b, keep a
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("refreshes the TTL on get()", () => {
    const cache = new SessionCache<string>({ ttlMs: 100, capacity: 3, now: () => nowMs });
    cache.set("a", "A");
    tick(80);
    expect(cache.get("a")).toBe("A"); // touch resets the idle clock
    tick(80);
    expect(cache.get("a")).toBe("A"); // would have been evicted without touch
  });

  it("dispose is called for every removal path", () => {
    let disposed: string[] = [];
    const track = (v: string) => disposed.push(v);
    const cache = new SessionCache<string>({ ttlMs: 100, capacity: 1, dispose: track, now: () => nowMs });
    cache.set("a", "A");
    cache.set("b", "B");            // capacity eviction disposes A
    expect(disposed).toEqual(["A"]);
    cache.delete("b");              // explicit delete disposes B
    expect(disposed).toEqual(["A", "B"]);
    cache.set("c", "C");
    cache.deleteWhere((k) => k === "c");
    expect(disposed).toEqual(["A", "B", "C"]);
    cache.set("d", "D");
    cache.disposeAll();             // clear disposes D
    expect(disposed).toEqual(["A", "B", "C", "D"]);
    expect(cache.size).toBe(0);
  });

  it("a throwing dispose must not break eviction", () => {
    const cache = new SessionCache<string>({
      ttlMs: 100, capacity: 1,
      dispose: () => { throw new Error("boom"); },
      now: () => nowMs,
    });
    cache.set("a", "A");
    cache.set("b", "B"); // evicts a; dispose throws but eviction proceeds
    expect(cache.has("b")).toBe(true);
    expect(cache.get("b")).toBe("B");
  });

  it("deleteWhere removes all matching keys", () => {
    const cache = new SessionCache<string>({ ttlMs: 1000, capacity: 5, now: () => nowMs });
    cache.set("u1:x", "1");
    cache.set("u1:y", "2");
    cache.set("u2:x", "3");
    expect(cache.deleteWhere((k) => k.startsWith("u1:"))).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.has("u2:x")).toBe(true);
  });

  it("stats report size/capacity/eviction counters", () => {
    const cache = new SessionCache<string>({ ttlMs: 1000, capacity: 2, now: () => nowMs });
    cache.set("a", "A");
    cache.set("b", "B");
    cache.set("c", "C"); // LRU eviction of a
    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.capacity).toBe(2);
    expect(stats.evictedOther).toBe(1);
    expect(stats.evictedIdle).toBe(0);
  });

  it("rejects invalid options", () => {
    expect(() => new SessionCache({ ttlMs: 0, capacity: 1 })).toThrow();
    expect(() => new SessionCache({ ttlMs: 100, capacity: 0 })).toThrow();
  });
});
