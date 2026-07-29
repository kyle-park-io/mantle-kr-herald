import { describe, it, expect } from "vitest";
import { makeLoadQuota } from "../../src/cli/loadQuota";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import type { PublishingQuota } from "../../src/adapters/send/TypefullyQuota";

/** A minimal ledger backed by a live array reference, so a test can mutate it after construction. */
function fakeLedger(rows: DeliveryEntry[]): DeliveryLedger {
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map((r) => `${r.itemId}:${r.type}:${r.outletId}`)),
    add: async () => {},
    remove: async () => {},
  };
}

const CONFIG = { apiKey: "KEY", socialSetId: "42" };
const QUOTA: PublishingQuota = { used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" };

/** An X row sent but not yet reconciled — what `awaitingPublish` counts as in-flight. */
const awaitingRow = (outletId = "x-post"): DeliveryEntry => ({
  itemId: "x:1",
  type: "x",
  outletId,
  status: "sent",
  at: "2026-07-29T00:00:00Z",
  by: "auto",
  postId: "draft-1",
  // no `url` — a Typefully draft has no x.com url until reconciled
});

describe("makeLoadQuota", () => {
  it("serves the cached value inside the TTL", async () => {
    let calls = 0;
    let now = 0;
    const loadQuota = makeLoadQuota(fakeLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        return QUOTA;
      },
      now: () => now,
      ttlMs: 60_000,
    });
    expect(await loadQuota()).toEqual({ quota: QUOTA, inFlight: 0 });
    now += 30_000; // still inside the 60s TTL
    expect(await loadQuota()).toEqual({ quota: QUOTA, inFlight: 0 });
    expect(calls).toBe(1);
  });

  it("refetches once the TTL elapses", async () => {
    let calls = 0;
    let now = 0;
    const loadQuota = makeLoadQuota(fakeLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        return { ...QUOTA, remaining: QUOTA.remaining - calls };
      },
      now: () => now,
      ttlMs: 60_000,
    });
    expect((await loadQuota()).quota?.remaining).toBe(5);
    now += 60_001; // past the TTL
    expect((await loadQuota()).quota?.remaining).toBe(4);
    expect(calls).toBe(2);
  });

  // "Unknown" and "exhausted" are different states, and only one of them means stop sending — a
  // transient failure must not blank the banner for a full minute the way a real quota read would.
  it("does not cache an error", async () => {
    let calls = 0;
    const loadQuota = makeLoadQuota(fakeLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        throw new Error("HTTP 500");
      },
    });
    expect(await loadQuota()).toEqual({ error: "HTTP 500", inFlight: 0 });
    expect(await loadQuota()).toEqual({ error: "HTTP 500", inFlight: 0 });
    expect(calls).toBe(2);
  });

  it("recomputes inFlight on every call, even while the cached quota is still fresh", async () => {
    const rows: DeliveryEntry[] = [];
    const loadQuota = makeLoadQuota(fakeLedger(rows), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect((await loadQuota()).inFlight).toBe(0);
    rows.push(awaitingRow("x-post"));
    expect((await loadQuota()).inFlight).toBe(1);
    rows.push(awaitingRow("x-post")); // same outlet — awaitingPublish counts rows, not rooms
    expect((await loadQuota()).inFlight).toBe(2);
  });

  it("only counts rows awaitingPublish considers in-flight (a reconciled X row does not count)", async () => {
    const reconciled: DeliveryEntry = { ...awaitingRow(), url: "https://x.com/i/status/1" };
    const telegram: DeliveryEntry = { itemId: "x:2", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-07-29T00:00:00Z", by: "auto" };
    const loadQuota = makeLoadQuota(fakeLedger([reconciled, telegram, awaitingRow("x-post")]), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect((await loadQuota()).inFlight).toBe(1);
  });
});
