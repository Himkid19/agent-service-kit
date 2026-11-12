import { describe, it, expect } from "vitest";
import { LlmGate } from "../src/services/llm-gate.js";

describe("LlmGate", () => {
  it("allows up to the limit, queues beyond it", async () => {
    const gate = new LlmGate(2, 100);
    await gate.acquire();
    await gate.acquire();
    expect(gate.stats().active).toBe(2);
    expect(gate.stats().waiting).toBe(0);

    const third = gate.acquire(); // queued, not rejected yet
    await Promise.resolve();
    expect(gate.stats().waiting).toBe(1);
    expect(gate.stats().active).toBe(2);

    gate.release(); // slot goes directly to the waiter
    await third;
    expect(gate.stats().active).toBe(2);
    expect(gate.stats().waiting).toBe(0);
    gate.release();
    gate.release();
    expect(gate.stats().active).toBe(0);
  });

  it("rejects a queued request after the queue timeout", async () => {
    const gate = new LlmGate(1, 30);
    await gate.acquire();
    const rejected = gate.acquire();
    await expect(rejected).rejects.toThrow("LLM_CALL_QUEUE_TIMEOUT");
    // Rejection is counted for observability.
    expect(gate.stats().totalRejected).toBe(1);
    // Slot is still held by the first holder; queue is now empty.
    expect(gate.stats().waiting).toBe(0);
  });

  it("release decrements when there are no waiters", async () => {
    const gate = new LlmGate(2, 10);
    await gate.acquire();
    gate.release();
    expect(gate.stats().active).toBe(0);
  });

  it("release never goes below zero", () => {
    const gate = new LlmGate(2, 10);
    gate.release();
    gate.release();
    expect(gate.stats().active).toBe(0);
  });

  it("must be released exactly once after the wait expires", async () => {
    // Regression shape: holder releases -> oldest waiter proceeds. If the
    // waiter's timeout fired it must NOT consume the next release.
    const gate = new LlmGate(1, 20);
    await gate.acquire();
    const queued = gate.acquire();
    await expect(queued).rejects.toThrow("LLM_CALL_QUEUE_TIMEOUT");
    gate.release(); // real holder finishes
    await gate.acquire(); // limit=1 must be free now (active increments)
    expect(gate.stats().active).toBe(1);
    gate.release();
    expect(gate.stats().active).toBe(0);
  });
});
