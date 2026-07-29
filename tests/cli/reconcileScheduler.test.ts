import { describe, it, expect, vi, afterEach } from "vitest";
import { startReconcileScheduler } from "../../src/cli/reconcileScheduler";

afterEach(() => vi.useRealTimers());

describe("startReconcileScheduler", () => {
  it("runs a pass on each tick", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, retired: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(runs).toBe(2);
  });

  /**
   * Typefully is slow sometimes; overlapping passes would double every lookup for no gain.
   *
   * This has to rule out not just "no concurrent pass" but also a single-slot queue that
   * remembers the skipped tick and fires it the instant the blocking pass resolves — that would
   * also land on `started === 2` eventually, just early. So after releasing the gate we let the
   * blocked pass's promise chain settle (without advancing virtual time) and assert nothing fired
   * yet, *then* advance to the next real tick and assert it did.
   */
  it("skips a tick while the previous pass is still running", async () => {
    vi.useFakeTimers();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const stop = startReconcileScheduler(async () => { started += 1; await gate; return { reconciled: 0, retired: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1);
    release();
    // Flush the released pass's .then/.catch/.finally chain without moving virtual time forward,
    // so a genuine skip and a "retry immediately once the slot frees up" queue are told apart.
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);
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
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, retired: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(1);
  });

  /**
   * A draft can be deleted out-of-band while this process runs unattended, with nobody watching a
   * terminal. `reconciled` already gets a log line the moment a pass finds one; `retired` must too
   * — a tick that silently drops `{ retired: 1 }` on the floor is the exact "state changed, nobody
   * told" defect this whole branch exists to remove (see `ReconcilePublished`'s own doc comment).
   */
  it("logs a retired count, in Korean, matching the board's own vocabulary for the state", async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const stop = startReconcileScheduler(
      async () => ({ reconciled: 0, retired: 1, pending: 0 }),
      { intervalMs: 1000, log: (m) => logged.push(m) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(logged.some((m) => m.includes("1") && m.includes("retired"))).toBe(true);
    // The board's badge for this exact state is "예약 취소됨" — the operator reading this log and
    // the operator reading the board must recognize the same event, not two different vocabularies.
    expect(logged.join(" ")).toContain("예약 취소됨");
    // Never "실패" (failed) — nothing failed, a draft was deliberately deleted before it published.
    expect(logged.join(" ")).not.toContain("실패");
  });

  it("logs both a reconciled and a retired count on the same tick — one does not suppress the other", async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const stop = startReconcileScheduler(
      async () => ({ reconciled: 2, retired: 1, pending: 0 }),
      { intervalMs: 1000, log: (m) => logged.push(m) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(logged.some((m) => m.includes("2") && m.includes("x.com"))).toBe(true);
    expect(logged.some((m) => m.includes("1") && m.includes("retired"))).toBe(true);
  });

  it("does not log a retired line when nothing was retired", async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const stop = startReconcileScheduler(
      async () => ({ reconciled: 0, retired: 0, pending: 3 }),
      { intervalMs: 1000, log: (m) => logged.push(m) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(logged).toEqual([]);
  });
});
