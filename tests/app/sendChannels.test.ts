import { describe, it, expect } from "vitest";
import { SendChannels } from "../../src/app/SendChannels";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import { deliveryKey } from "../../src/domain/delivery/models";
import { outletsForChannel } from "../../src/domain/outlet/models";

const rendering = (o: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "x:1", type: "announcement", channel: "telegram", text: "**hi** everyone", refined: false,
  createdAt: "2026-07-27T00:00:00Z", status: "approved", ...o,
});

function fakeStore(rows: ChannelRendering[]): FormattingStore {
  return { loadAll: async () => rows, upsert: async () => {}, listRenderedKeys: async () => new Set() };
}
function fakeLedger(seed: DeliveryEntry[] = []) {
  let rows = [...seed];
  const added: DeliveryEntry[] = [];
  const ledger: DeliveryLedger = {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map(deliveryKey)),
    add: async (e: DeliveryEntry) => {
      rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(e)), e];
      added.push(e);
    },
    remove: async (key: string) => {
      rows = rows.filter((r) => deliveryKey(r) !== key);
    },
  };
  return { ledger, added };
}
const okSender = (name: "telegram" | "x"): ChannelSender => ({ name, send: async () => ({ postId: "p", url: "u" }) });

/**
 * Telegram now fans out to two auto rooms (맨틀 한국 커뮤니티 + 맨틀 한국 데브방), and a room with no
 * chat id resolved is skipped — so every Telegram test has to supply both ids or it would measure
 * the skip path instead of the send path.
 */
const TG_CHAT_IDS = { "tg-community": "-100111", "tg-dev": "-100222" };
const sentEntry = (o: Partial<DeliveryEntry>): DeliveryEntry => ({
  itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "t", by: "auto", ...o,
});
/** Both auto Telegram rooms already delivered — the pre-outlet "already in the ledger" state. */
const bothTelegramRooms = (itemId = "x:1") => [
  sentEntry({ itemId, outletId: "tg-community" }),
  sentEntry({ itemId, outletId: "tg-dev" }),
];

describe("SendChannels", () => {
  it("sends only approved renderings for the requested channels, and ledgers each", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", status: "approved" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → skip
      rendering({ itemId: "x:3", channel: "kakao", status: "approved" }),    // not a sendable channel → skip
    ]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Two sends for one rendering: telegram carries two auto rooms, and each is ledgered separately.
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1", "x:1"]);
    expect(added.map((e) => e.outletId)).toEqual(["tg-community", "tg-dev"]);
  });

  it("skips a rendering already in the ledger (no second send)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    // Both rooms seeded — the old channel-keyed ledger had one row for "telegram"; per outlet that
    // same "nothing left to do" state is one row per room.
    const { ledger } = fakeLedger(bothTelegramRooms());
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return {}; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 2, failed: 0 });
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
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, recorder, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Doubled from 1/1: each rendering is now attempted once per auto room.
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 2 });
    expect(added.map((e) => e.itemId)).toEqual(["x:2", "x:2"]); // failed one is NOT ledgered → retryable
  });

  it("counts a post-send ledger-write failure as sent, not failed — never re-sends a live post", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const ledger: DeliveryLedger = {
      loadAll: async () => [],
      loadKeys: async () => new Set<string>(),
      add: async () => { throw new Error("disk full"); },
      remove: async () => {},
    };
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return { postId: "p" }; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // 2, not 1, because both rooms are delivered — the point is that neither is counted as failed.
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(sends).toBe(2);
  });

  it("sends only the item(s) named by the ids filter", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    const { ledger, added } = fakeLedger();
    const sender = okSender("telegram");
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({
      targets: ["telegram"],
      ids: new Set(["x:2"]),
    });
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 0 }); // one item × two rooms
    expect(added.map((e) => e.itemId)).toEqual(["x:2", "x:2"]);
  });

  it("fails fast on an over-limit segment instead of calling the sender (no 400→retry loop)", async () => {
    // "a".repeat(5000) survives emitTelegramBot's flattening/escaping untouched, so its visible
    // length (5000) genuinely exceeds TELEGRAM_MAX (4096) — this is a real overLimit segment
    // produced by the real emitter, not a stubbed/faked EmitResult.
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "a".repeat(5000) })]);
    const { ledger, added } = fakeLedger();
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return { postId: "p" }; } };
    // Chat ids supplied on purpose. Without them the rooms would drop out on the missing-id path
    // instead of the guard, and `expect(sends).toBe(0)` would hold for the wrong reason — the
    // sender is only proven untouched *by the guard* when the rooms are otherwise deliverable.
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Still 1: the limit is a property of the rendering, so it is counted once, not once per room.
    expect(res).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(sends).toBe(0);
    expect(added).toEqual([]);
  });

  it("archives every successful send, with the rendering's text and send metadata", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", text: "공지1" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → not archived
    ]);
    const { ledger } = fakeLedger();
    const archived: unknown[] = [];
    const sender: ChannelSender = { name: "telegram", send: async () => ({ postId: "p9", url: "u9" }) };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, async (e) => {
      archived.push(e);
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 0 });
    // One archive entry per send, each naming its own room. The archivers `upload()` rather than
    // `update()`, so two entries that differ only in message id would otherwise land in the Drive
    // `sent/` folder under one name — see sentFileName.
    const entry = { itemId: "x:1", type: "announcement", channel: "telegram", text: "공지1", postId: "p9", url: "u9", sentAt: expect.any(String) };
    expect(archived).toEqual([
      { ...entry, outletId: "tg-community" },
      { ...entry, outletId: "tg-dev" },
    ]);
  });

  it("does not archive a skipped (already-sent) rendering", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger(bothTelegramRooms());
    let archives = 0;
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      archives++;
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(archives).toBe(0);
  });

  it("a best-effort archive failure does not fail the send", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, undefined, async () => {
      throw new Error("disk full");
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1", "x:1"]); // send + ledger stood; only the archive failed
  });

  it("reads photos from the rendering text and passes them to the sender", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "본문\n\n![](https://pbs.twimg.com/media/a.jpg)" })]);
    const { ledger } = fakeLedger();
    const got: { photos?: string[]; segments: string[] }[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push({ photos: req.photos, segments: req.segments }); return { postId: "1" }; } };
    await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(got).toHaveLength(1); // x-post only — x-article has its own pipeline
    expect(got[0].photos).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
    expect(got[0].segments.join("")).not.toContain("![("); // marker stripped from delivered text
    expect(got[0].segments.join("")).toContain("본문");
  });

  it("sends a marker-free rendering with photos: []", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "그냥 텍스트" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram", send: async (req) => { got.push(req.photos); return { postId: "p" }; } };
    await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(got).toEqual([[], []]); // one per auto Telegram room
  });

  it("a [영상]-only rendering sends text-only (photos: []) and does not throw", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "영상 트윗\n\n[영상]" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push(req.photos); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(res.sent).toBe(1);
    expect(got[0]).toEqual([]);
  });

  it("fail-fasts an over-280 x rendering at the default (standard) limit", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sender = okSender("x");
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(res).toEqual({ sent: 0, skipped: 0, failed: 1 });
  });

  it("sends an over-280 x rendering when xMaxWeighted is 25000 (Premium)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sent: string[][] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { sent.push(req.segments); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, undefined, undefined, undefined, 25000).run({ targets: ["x"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent[0][0]).toBe("가".repeat(150));
  });

  it("sends one message per auto outlet on the channel, and skips manual ones", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sent: { chatId?: string }[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push({ chatId: req.chatId }); return { postId: "m1", url: "u" }; } };
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(res.sent).toBe(2); // tg-community + tg-dev; tg-kol and tg-blockchain are manual
    expect(sent.map((s) => s.chatId).sort()).toEqual(["-100111", "-100222"]);
    expect((await ledger.loadKeys()).size).toBe(2);
  });

  it("counts an auto outlet with no chat id as failed, and still sends to the others", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    const { ledger } = fakeLedger();
    // Day one of Task 2's staged .env migration: only the legacy TELEGRAM_CHAT_ID is set, so the map
    // holds 커뮤니티 alone and 데브방 has no id.
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, () => "T", undefined, outletsForChannel, { "tg-community": "-100111" }).run({ targets: ["telegram"] });

    // failed: 1, not a silent skip — `sent 1 · skipped 0 · failed 0` would read as complete success
    // while 데브방 received nothing, which is the exact silence this task exists to remove.
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 1 });
    // Nothing ledgered for the unconfigured room, so a rerun after fixing .env delivers only it.
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  it("does not re-send a room already in the ledger, but still sends its sibling room", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sent: (string | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push(req.chatId); return { postId: "m1" }; } };
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:1", outletId: "tg-community", at: "T" })]);
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(res.sent).toBe(1);
    expect(res.skipped).toBe(1);
    expect(sent).toEqual(["-100222"]); // only 데브방; 커뮤니티 was already delivered
    expect([...(await ledger.loadKeys())].sort()).toEqual(["x:1:announcement:tg-community", "x:1:announcement:tg-dev"]);
  });

  it("restricts to the rooms named by --outlets", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"], outletIds: ["tg-dev"] });

    expect(res.sent).toBe(1);
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-dev"]);
  });

  it("sends an approved x rendering once — the article outlet has its own pipeline", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", type: "x", channel: "x", text: "트윗" })]);
    let sends = 0;
    const sender: ChannelSender = { name: "typefully", send: async () => { sends++; return { postId: "1" }; } };
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });

    // x-post and x-article are both auto on the x channel, but x-article is delivered by
    // `send:x-article` from the translation — sending it here too would post the same copy twice.
    expect(sends).toBe(1);
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.outletId)).toEqual(["x-post"]);
  });
});
