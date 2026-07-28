import { describe, it, expect } from "vitest";
import { ReconcilePublished } from "../../src/app/ReconcilePublished";

function ledgers(channelRows: any[], articleRows: any[]) {
  const c = [...channelRows];
  const a = [...articleRows];
  const channel = {
    loadAll: async () => c,
    add: async (e: any) => {
      const i = c.findIndex((r) => r.itemId === e.itemId && r.type === e.type && r.channel === e.channel);
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
  return { channel, article, c, a };
}

describe("ReconcilePublished", () => {
  it("rewrites a scheduled X channel row with the published tweet id + url", async () => {
    const { channel, article, c } = ledgers(
      [{ itemId: "x:1", type: "x", channel: "x", postId: "10097383", url: undefined, sentAt: "t" }], [],
    );
    const lookup = { published: async () => ({ xUrl: "https://x.com/a/status/2082", xId: "2082" }) };
    const res = await new ReconcilePublished(channel as any, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 1, pending: 0 });
    expect(c[0]).toMatchObject({ itemId: "x:1", postId: "2082", url: "https://x.com/a/status/2082" });
  });

  it("leaves a still-scheduled row untouched (pending)", async () => {
    const { channel, article, c } = ledgers(
      [{ itemId: "x:1", type: "x", channel: "x", postId: "100", url: undefined, sentAt: "t" }], [],
    );
    const lookup = { published: async () => ({}) };
    const res = await new ReconcilePublished(channel as any, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 1 });
    expect(c[0].postId).toBe("100");
  });

  it("skips an already-reconciled (x.com) row and a telegram row — no lookup for either", async () => {
    let lookups = 0;
    const { channel, article } = ledgers(
      [
        { itemId: "x:1", type: "x", channel: "x", postId: "2082", url: "https://x.com/a/status/2082", sentAt: "t" },
        { itemId: "x:2", type: "announcement", channel: "telegram", postId: "5", url: "https://t.me/c/1/5", sentAt: "t" },
      ], [],
    );
    const lookup = { published: async () => { lookups += 1; return {}; } };
    const res = await new ReconcilePublished(channel as any, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 0 });
    expect(lookups).toBe(0);
  });

  it("reconciles an x-article row (url null → published article url + id)", async () => {
    const { channel, article, a } = ledgers([], [{ itemId: "x:9", postId: "10097410", url: null, sentAt: "t" }]);
    const lookup = { published: async () => ({ articleUrl: "https://x.com/i/article/2082141", articleId: "2082141" }) };
    const res = await new ReconcilePublished(channel as any, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 1, pending: 0 });
    expect(a[0]).toMatchObject({ itemId: "x:9", postId: "2082141", url: "https://x.com/i/article/2082141" });
  });

  it("counts a lookup that throws as pending, not a crash", async () => {
    const { channel, article } = ledgers(
      [{ itemId: "x:1", type: "x", channel: "x", postId: "100", url: undefined, sentAt: "t" }], [],
    );
    const lookup = { published: async () => { throw new Error("network"); } };
    const res = await new ReconcilePublished(channel as any, article as any, lookup).run();
    expect(res).toEqual({ reconciled: 0, pending: 1 });
  });
});
