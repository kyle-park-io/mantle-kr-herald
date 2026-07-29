import { describe, it, expect, afterEach } from "vitest";
import { makeReadHeadroom, makeLoadHeadroom, headroomReader } from "../../src/cli/publishHeadroom";
import type { Headroom } from "../../src/domain/send/headroom";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import type { PublishingQuota } from "../../src/adapters/send/TypefullyQuota";

/** An article-ledger row shaped like `XArticleSentEntry`, without importing the concrete adapter. */
interface ArticleRow {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
}

/** A minimal ledger backed by a live array reference, so a test can mutate it after construction. */
function fakeDeliveryLedger(rows: DeliveryEntry[]): DeliveryLedger {
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map((r) => `${r.itemId}:${r.type}:${r.outletId}`)),
    add: async () => {},
    remove: async () => {},
  };
}

/** Same shape, for the article ledger — a live array reference for the same reason. */
function fakeArticleLedger(rows: ArticleRow[]): { loadAll(): Promise<ArticleRow[]> } {
  return { loadAll: async () => rows };
}

const CONFIG = { apiKey: "KEY", socialSetId: "42" };
const QUOTA: PublishingQuota = { used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" };

/** An X row sent but not yet reconciled — what `awaitingPublish` counts as in-flight. */
const sentRow = (o: Partial<DeliveryEntry> = {}): DeliveryEntry => ({
  itemId: "x:1",
  type: "x",
  outletId: "x-post",
  status: "sent",
  at: "2026-07-29T00:00:00Z",
  by: "auto",
  postId: "draft-1",
  // no `url` — a Typefully draft has no x.com url until reconciled
  ...o,
});

/** An x-article row scheduled but not yet reconciled — what `awaitingArticlePublish` counts. */
const articleRow = (o: Partial<ArticleRow> = {}): ArticleRow => ({
  itemId: "x:9",
  postId: "10097410",
  sentAt: "2026-07-29T00:00:00Z",
  ...o,
});

describe("makeReadHeadroom", () => {
  // Ported from tests/cli/loadQuota.test.ts — the TTL and never-cache-an-error behaviour must survive
  // the merge into one module.
  it("serves the cached value inside the TTL", async () => {
    let calls = 0;
    let now = 0;
    const read = makeReadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        return QUOTA;
      },
      now: () => now,
      ttlMs: 60_000,
    });
    const expected: Headroom = { remaining: 6, used: 9, inFlight: 0, available: 6, resetsAt: QUOTA.resetsAt };
    expect(await read()).toEqual(expected);
    now += 30_000; // still inside the 60s TTL
    expect(await read()).toEqual(expected);
    expect(calls).toBe(1);
  });

  it("refetches once the TTL elapses", async () => {
    let calls = 0;
    let now = 0;
    const read = makeReadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        return { ...QUOTA, remaining: QUOTA.remaining - calls };
      },
      now: () => now,
      ttlMs: 60_000,
    });
    expect((await read()).remaining).toBe(5);
    now += 60_001; // past the TTL
    expect((await read()).remaining).toBe(4);
    expect(calls).toBe(2);
  });

  // "Unknown" and "exhausted" are different states, and only one of them means stop sending — a
  // transient failure must not blank the banner (or wrongly refuse a send) for a full minute the way
  // a real quota read would. Unlike the old `loadQuota.ts`, `makeReadHeadroom` throws rather than
  // answering `{ error }` — that is the gate's contract, which already catches (see SendChannels.ts).
  it("throws rather than caching an error", async () => {
    let calls = 0;
    const read = makeReadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        throw new Error("HTTP 500");
      },
    });
    await expect(read()).rejects.toThrow("HTTP 500");
    await expect(read()).rejects.toThrow("HTTP 500");
    expect(calls).toBe(2); // not cached — each call re-attempts the read
  });

  it("recomputes inFlight on every call, even while the cached quota is still fresh", async () => {
    const rows: DeliveryEntry[] = [];
    const read = makeReadHeadroom(fakeDeliveryLedger(rows), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect((await read()).inFlight).toBe(0);
    rows.push(sentRow());
    expect((await read()).inFlight).toBe(1);
    rows.push(sentRow({ postId: "draft-2" })); // same outlet — awaitingPublish counts rows, not rooms
    expect((await read()).inFlight).toBe(2);
  });

  it("only counts delivery rows awaitingPublish considers in-flight (a reconciled X row does not count)", async () => {
    const reconciled: DeliveryEntry = { ...sentRow(), url: "https://x.com/i/status/1" };
    const telegram: DeliveryEntry = { itemId: "x:2", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-07-29T00:00:00Z", by: "auto" };
    const read = makeReadHeadroom(fakeDeliveryLedger([reconciled, telegram, sentRow({ postId: "draft-2" })]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect((await read()).inFlight).toBe(1);
  });

  // New behaviour this module adds: the old `loadQuota.ts` only ever read the delivery ledger, so a
  // scheduled x-article publish never counted against the headroom either the gate or the banner saw.
  it("counts in-flight rows from BOTH ledgers", async () => {
    const delivery = fakeDeliveryLedger([sentRow({ outletId: "x-post", postId: "10104901" })]);
    const article = fakeArticleLedger([articleRow({ itemId: "x:9", postId: "10097410", sentAt: "2026-07-29T00:00:00Z" })]);
    const read = makeReadHeadroom(delivery, article, {
      readQuota: async () => ({ used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" }),
      loadConfig: () => ({ apiKey: "K", socialSetId: "42" }),
    });
    const h = await read();
    expect(h.inFlight).toBe(2);
    expect(h.available).toBe(4);
    expect(h.remaining).toBe(6);
    // The banner's denominator would be lost without it.
    expect(h.used).toBe(9);
  });

  it("only counts article rows awaitingArticlePublish considers in-flight (a reconciled article does not count)", async () => {
    const reconciled = articleRow({ itemId: "x:8", url: "https://x.com/i/status/2" });
    const read = makeReadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([reconciled, articleRow({ itemId: "x:9" })]), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect((await read()).inFlight).toBe(1);
  });

  it("recomputes in-flight on every call while the quota stays cached", async () => {
    const deliveryRows: DeliveryEntry[] = [];
    const articleRows: ArticleRow[] = [];
    let calls = 0;
    let now = 0;
    const read = makeReadHeadroom(fakeDeliveryLedger(deliveryRows), fakeArticleLedger(articleRows), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        return QUOTA;
      },
      now: () => now,
      ttlMs: 60_000,
    });
    expect((await read()).inFlight).toBe(0);
    deliveryRows.push(sentRow());
    now += 1_000; // still inside the TTL
    expect((await read()).inFlight).toBe(1);
    articleRows.push(articleRow());
    now += 1_000;
    expect((await read()).inFlight).toBe(2);
    expect(calls).toBe(1); // the quota fetch did not repeat — only inFlight moved
  });

  it("leaves available negative rather than clamping — the caller clamps for display", async () => {
    const delivery = fakeDeliveryLedger([
      sentRow({ itemId: "x:1", postId: "draft-1" }),
      sentRow({ itemId: "x:2", postId: "draft-2" }),
    ]);
    const read = makeReadHeadroom(delivery, fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => ({ used: 14, remaining: 1, resetsAt: "" }),
    });
    expect((await read()).available).toBe(-1);
  });
});

describe("makeLoadHeadroom", () => {
  it("answers { headroom } on success", async () => {
    const read = makeLoadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => QUOTA,
    });
    expect(await read()).toEqual({ headroom: { remaining: 6, used: 9, inFlight: 0, available: 6, resetsAt: QUOTA.resetsAt } });
  });

  // Ported from tests/cli/loadQuota.test.ts's "does not cache an error" — `makeLoadHeadroom` converts
  // the throw into `{ error }` rather than caching it, so a transient blip does not blank the banner.
  it("answers { error } instead of throwing, and does not cache the failure", async () => {
    let calls = 0;
    const read = makeLoadHeadroom(fakeDeliveryLedger([]), fakeArticleLedger([]), {
      loadConfig: () => CONFIG,
      readQuota: async () => {
        calls += 1;
        throw new Error("HTTP 500");
      },
    });
    expect(await read()).toEqual({ error: "HTTP 500" });
    expect(await read()).toEqual({ error: "HTTP 500" });
    expect(calls).toBe(2);
  });
});

// Ported from tests/cli/typefullyQuotaReader.test.ts, updated for headroomReader's extra ledger args.
describe("headroomReader", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is undefined when X is not a target", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(headroomReader(["telegram"], fakeDeliveryLedger([]), fakeArticleLedger([]))).toBeUndefined();
  });

  // A Telegram-only install has no Typefully credentials; it must not fail to start over a gate that
  // has nothing to guard.
  it("is undefined when Typefully is unconfigured", () => {
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_SOCIAL_SET_ID;
    expect(headroomReader(["x"], fakeDeliveryLedger([]), fakeArticleLedger([]))).toBeUndefined();
  });

  it("is a reader when X is a target and Typefully is configured", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(typeof headroomReader(["x"], fakeDeliveryLedger([]), fakeArticleLedger([]))).toBe("function");
  });
});
