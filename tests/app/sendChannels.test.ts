import { describe, it, expect } from "vitest";
import { SendChannels } from "../../src/app/SendChannels";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { ChannelSentEntry } from "../../src/domain/send/channels";
import { sentKey } from "../../src/domain/send/channels";

const rendering = (o: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "x:1", type: "announcement", channel: "telegram", text: "**hi** everyone", refined: false,
  createdAt: "2026-07-27T00:00:00Z", status: "approved", ...o,
});

function fakeStore(rows: ChannelRendering[]): FormattingStore {
  return { loadAll: async () => rows, upsert: async () => {}, listRenderedKeys: async () => new Set() };
}
function fakeLedger() {
  const keys = new Set<string>();
  const added: ChannelSentEntry[] = [];
  return { ledger: { loadKeys: async () => new Set(keys), add: async (e: ChannelSentEntry) => { keys.add(sentKey(e)); added.push(e); } }, added, keys };
}
const okSender = (name: "telegram" | "x"): ChannelSender => ({ name, send: async () => ({ postId: "p", url: "u" }) });

describe("SendChannels", () => {
  it("sends only approved renderings for the requested channels, and ledgers each", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", status: "approved" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → skip
      rendering({ itemId: "x:3", channel: "kakao", status: "approved" }),    // not a sendable channel → skip
    ]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1"]);
  });

  it("skips a rendering already in the ledger (no second send)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger();
    await ledger.add({ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram", sentAt: "t" });
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return {}; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sends).toBe(0);
  });

  it("isolates a failing send and still sends the rest; a best-effort recorder failure does not fail the send", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    const { ledger, added } = fakeLedger();
    const sender: ChannelSender = { name: "telegram", send: async (r) => { if (r.itemId === "x:1") throw new Error("boom"); return { postId: "p" }; } };
    const recorder = async () => { throw new Error("no sheet"); };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, recorder).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(added.map((e) => e.itemId)).toEqual(["x:2"]); // failed one is NOT ledgered → retryable
  });

  it("counts a post-send ledger-write failure as sent, not failed — never re-sends a live post", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const ledger = {
      loadKeys: async () => new Set<string>(),
      add: async () => { throw new Error("disk full"); },
    };
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return { postId: "p" }; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sends).toBe(1);
  });

  it("sends only the item(s) named by the ids filter", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    const { ledger, added } = fakeLedger();
    const sender = okSender("telegram");
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({
      targets: ["telegram"],
      ids: new Set(["x:2"]),
    });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:2"]);
  });

  it("fails fast on an over-limit segment instead of calling the sender (no 400→retry loop)", async () => {
    // "a".repeat(5000) survives emitTelegramBot's flattening/escaping untouched, so its visible
    // length (5000) genuinely exceeds TELEGRAM_MAX (4096) — this is a real overLimit segment
    // produced by the real emitter, not a stubbed/faked EmitResult.
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "a".repeat(5000) })]);
    const { ledger, added } = fakeLedger();
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return { postId: "p" }; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(sends).toBe(0);
    expect(added).toEqual([]);
  });

  it("archives each successful send once, with the rendering's text and send metadata", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", text: "공지1" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → not archived
    ]);
    const { ledger } = fakeLedger();
    const archived: unknown[] = [];
    const sender: ChannelSender = { name: "telegram", send: async () => ({ postId: "p9", url: "u9" }) };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, async (e) => {
      archived.push(e);
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(archived).toEqual([
      { itemId: "x:1", type: "announcement", channel: "telegram", text: "공지1", postId: "p9", url: "u9", sentAt: expect.any(String) },
    ]);
  });

  it("does not archive a skipped (already-sent) rendering", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger();
    await ledger.add({ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram", sentAt: "t" });
    let archives = 0;
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      archives++;
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(archives).toBe(0);
  });

  it("a best-effort archive failure does not fail the send", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      throw new Error("disk full");
    }).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1"]); // send + ledger stood; only the archive failed
  });

  it("passes photosFor(itemId) through to the sender", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push(req.photos); return { postId: "1" }; } };
    await new SendChannels(
      store, { telegram: undefined, x: sender }, ledger, undefined, undefined, undefined,
      async (id: string) => (id === "x:1" ? ["https://pbs.twimg.com/media/a.jpg"] : []),
    ).run({ targets: ["x"] });
    expect(got[0]).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
  });

  it("with no photosFor dep, the sender still receives photos: [] (backward compat)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram", send: async (req) => { got.push(req.photos); return { postId: "p" }; } };
    await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(got[0]).toEqual([]);
  });
});
