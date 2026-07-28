import { describe, it, expect } from "vitest";
import { ReconcilePublished } from "../../src/app/ReconcilePublished";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import { deliveryKey } from "../../src/domain/delivery/models";

/** A `deliveries.json` row as `send:channels` writes it: keyed by room, no `channel` field. */
const row = (o: Partial<DeliveryEntry>): DeliveryEntry => ({
  itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "t", by: "auto", ...o,
});

function ledgers(deliveryRows: DeliveryEntry[], articleRows: any[]) {
  const c = [...deliveryRows];
  const a = [...articleRows];
  const delivery = {
    loadAll: async () => c,
    add: async (e: DeliveryEntry) => {
      const i = c.findIndex((r) => deliveryKey(r) === deliveryKey(e));
      if (i >= 0) c[i] = e; else c.push(e);
    },
  };
  const article = {
    loadAll: async () => a,
    add: async (e: any) => {
      const i = a.findIndex((r) => r.itemId === e.itemId);
      if (i >= 0) a[i] = e; else a.push(e);
    },
  };
  return { delivery, article, c, a };
}

describe("ReconcilePublished", () => {
  it("rewrites a scheduled X delivery row with the published tweet id + url", async () => {
    const { delivery, article, c } = ledgers([row({ postId: "10097383", url: undefined })], []);
    const lookup = { published: async () => ({ xUrl: "https://x.com/a/status/2082", xId: "2082" }) };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 1, pending: 0 });
    // The X room is found through its outlet — the row itself carries no channel to filter on.
    expect(c[0]).toMatchObject({ itemId: "x:1", outletId: "x-post", postId: "2082", url: "https://x.com/a/status/2082" });
  });

  it("leaves a still-scheduled row untouched (pending)", async () => {
    const { delivery, article, c } = ledgers([row({ postId: "100", url: undefined })], []);
    const lookup = { published: async () => ({}) };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 1 });
    expect(c[0].postId).toBe("100");
  });

  it("skips an already-reconciled (x.com) row and a telegram room — no lookup, nothing rewritten", async () => {
    let lookups = 0;
    const { delivery, article, c } = ledgers(
      [
        row({ itemId: "x:1", postId: "2082", url: "https://x.com/a/status/2082" }),
        row({ itemId: "x:2", type: "announcement", outletId: "tg-community", postId: "5", url: "https://t.me/c/1/5" }),
        // A telegram room with no url at all: still never looked up — telegram publishes on send,
        // so a missing url there is not a scheduled draft waiting to resolve.
        row({ itemId: "x:3", type: "announcement", outletId: "tg-dev", postId: "6", url: undefined }),
      ], [],
    );
    const lookup = { published: async () => { lookups += 1; return {}; } };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 0 });
    expect(lookups).toBe(0);
    expect(c.map((r) => [r.outletId, r.postId, r.url])).toEqual([
      ["x-post", "2082", "https://x.com/a/status/2082"],
      ["tg-community", "5", "https://t.me/c/1/5"],
      ["tg-dev", "6", undefined],
    ]);
  });

  it("ignores a row whose outlet id is unknown rather than treating it as X", async () => {
    let lookups = 0;
    const { delivery, article } = ledgers([row({ outletId: "gone", postId: "100", url: undefined })], []);
    const lookup = { published: async () => { lookups += 1; return {}; } };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 0 });
    expect(lookups).toBe(0);
  });

  it("reconciles an x-article row (url null → published article url + id)", async () => {
    const { delivery, article, a } = ledgers([], [{ itemId: "x:9", postId: "10097410", url: null, sentAt: "t" }]);
    const lookup = { published: async () => ({ articleUrl: "https://x.com/i/article/2082141", articleId: "2082141" }) };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 1, pending: 0 });
    expect(a[0]).toMatchObject({ itemId: "x:9", postId: "2082141", url: "https://x.com/i/article/2082141" });
  });

  it("counts a lookup that throws as pending, not a crash", async () => {
    const { delivery, article } = ledgers([row({ postId: "100", url: undefined })], []);
    const lookup = { published: async () => { throw new Error("network"); } };
    const res = await new ReconcilePublished(delivery, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 1 });
  });
});
