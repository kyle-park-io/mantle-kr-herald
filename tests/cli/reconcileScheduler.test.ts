import { describe, it, expect, vi, afterEach } from "vitest";
import { startReconcileScheduler } from "../../src/cli/reconcileScheduler";

afterEach(() => vi.useRealTimers());

describe("startReconcileScheduler", () => {
  it("runs a pass on each tick", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(runs).toBe(2);
  });

  /** Typefully is slow sometimes; overlapping passes would double every lookup for no gain. */
  it("skips a tick while the previous pass is still running", async () => {
    vi.useFakeTimers();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const stop = startReconcileScheduler(async () => { started += 1; await gate; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(started).toBe(2);
  });

  // An unhandled rejection here would take the whole dashboard down.
  it("does not propagate a throwing pass, and keeps ticking", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const logged: string[] = [];
    const stop = startReconcileScheduler(async () => { runs += 1; throw new Error("boom"); }, { intervalMs: 1000, log: (m) => logged.push(m) });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(runs).toBe(2);
    expect(logged.join(" ")).toContain("boom");
  });

  it("stops ticking after stop()", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(1);
  });
});
