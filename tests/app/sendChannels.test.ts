import { describe, it, expect, vi, afterEach } from "vitest";
import { SendChannels } from "../../src/app/SendChannels";
import type { SendChannelsResult } from "../../src/app/SendChannels";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import type { PublishRecord } from "../../src/domain/sheet/models";
import { deliveryKey } from "../../src/domain/delivery/models";
import { outletsForChannel } from "../../src/domain/outlet/models";
import type { OutletOverride } from "../../src/domain/outlet/override";
import { overrideKey } from "../../src/domain/outlet/override";
import type { OutletOverrideStore } from "../../src/ports/OutletOverrideStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { Translation } from "../../src/domain/translation/models";
import { makeReadHeadroom } from "../../src/cli/publishHeadroom";
import type { Headroom } from "../../src/domain/send/headroom";

const rendering = (o: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "x:1", type: "announcement", channel: "telegram", text: "**hi** everyone", refined: false,
  createdAt: "2026-07-27T00:00:00Z", status: "approved", approvedAt: COPY_APPROVED_AT, ...o,
});

/**
 * `sendBlock` compares these two stamps, so every fixture carries one: a source approved before the
 * copy that descends from it — the ordinary state. Tests about the gate itself move one of them.
 */
const SOURCE_APPROVED_AT = "2026-07-26T00:00:00Z";
const COPY_APPROVED_AT = "2026-07-27T00:00:00Z";
const source = (itemId: string, o: Partial<Translation> = {}): Translation => ({
  itemId, source: "x", sourceText: "src", koreanText: "ko",
  status: "approved", translatedAt: "2026-07-25T00:00:00Z", approvedAt: SOURCE_APPROVED_AT, ...o,
});

/**
 * The KR X post a 공지 points readers at. Not on `source()` itself: a translation with no
 * `postedUrl` is the real pre-publication state, and the CTA tests below need to construct it.
 */
const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";
const CTA = `➡ 자세한 내용은 X에서 확인하세요 (${X_URL})`;
/** What a telegram 공지 actually carries into the room — every one of them now ends this way. */
const withCta = (text: string) => `${text}\n\n${CTA}`;

/**
 * Approved sources for every itemId this suite renders, each with its X post already up.
 *
 * `postedUrl` is part of the *ordinary* state at send time, not a detail: a telegram 공지 without
 * one is refused outright (see the CTA describe below), so a default without it would put every
 * test in this suite on the refusal path instead of the one it is about.
 */
function fakeTranslations(rows: Translation[] = ["x:1", "x:2", "x:3", "x:4"].map((id) => source(id, { postedUrl: X_URL }))): TranslationStore {
  return {
    loadAll: async () => rows,
    upsert: async () => {},
    listTranslatedIds: async () => new Set(rows.map((r) => r.itemId)),
  };
}

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
    replace: async (previous: DeliveryEntry, next: DeliveryEntry) => {
      rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(previous) && deliveryKey(r) !== deliveryKey(next)), next];
      added.push(next);
    },
  };
  return { ledger, added };
}
const okSender = (name: "telegram" | "x"): ChannelSender => ({ name, send: async () => ({ postId: "p", url: "u" }) });
/** Records what each room's send was actually asked to carry. */
function capturingSender(name: "telegram" | "x") {
  const got: { photos?: string[]; video?: string; segments: string[] }[] = [];
  const sender: ChannelSender = {
    name,
    send: async (req) => { got.push({ photos: req.photos, video: req.video, segments: req.segments }); return { postId: "1" }; },
  };
  return { sender, got };
}
function fakeOverrides(rows: OutletOverride[] = []): OutletOverrideStore {
  return {
    loadAll: async () => rows,
    upsert: async () => {},
    remove: async (key: string) => { rows = rows.filter((o) => overrideKey(o) !== key); },
  };
}
// A fork carries its own stamp for the same reason the group rendering does: it survives
// `[포맷 다시]`, so only the stamp separates a fork reviewed against the current source from one
// left over from an older draft of it.
const fork = (o: Partial<OutletOverride>): OutletOverride => ({
  itemId: "x:1", type: "announcement", outletId: "tg-dev", text: "데브방 전용 공지",
  status: "approved", createdAt: "T", approvedAt: COPY_APPROVED_AT, ...o,
});

/** A full result with everything at zero, so a test states only what it is about. */
const result = (o: Partial<SendChannelsResult> = {}): SendChannelsResult => ({
  sent: 0, skipped: 0, failed: 0, unconfigured: 0, unconfiguredEnv: [], withheld: 0, failures: [], warnings: [], ...o,
});

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
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Two sends for one rendering: telegram carries two auto rooms, and each is ledgered separately.
    expect(res).toEqual(result({ sent: 2 }));
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
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ skipped: 2 }));
    expect(sends).toBe(0);
  });

  it("isolates a failing send and still sends the rest; a best-effort recorder failure does not fail the send", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    // Seeded with an older delivery to both rooms: neither is a first delivery, so the
    // first-delivery guard stays out of the way and this measures failure isolation alone.
    const { ledger, added } = fakeLedger([
      sentEntry({ itemId: "x:0", outletId: "tg-community" }),
      sentEntry({ itemId: "x:0", outletId: "tg-dev" }),
    ]);
    const sender: ChannelSender = { name: "telegram", send: async (r) => { if (r.itemId === "x:1") throw new Error("boom"); return { postId: "p" }; } };
    const recorder = async () => { throw new Error("no sheet"); };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), recorder, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Doubled from 1/1: each rendering is now attempted once per auto room. The sender's own
    // message rides along per room — it is the only thing a dashboard operator, who has no server
    // log, can be told about why their [발송] did nothing.
    expect(res).toEqual(
      result({
        sent: 2,
        failed: 2,
        failures: [
          { key: "x:1:announcement:tg-community", error: "boom" },
          { key: "x:1:announcement:tg-dev", error: "boom" },
        ],
      }),
    );
    expect(added.map((e) => e.itemId)).toEqual(["x:2", "x:2"]); // failed one is NOT ledgered → retryable
  });

  it("counts a post-send ledger-write failure as sent, not failed — never re-sends a live post", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const ledger: DeliveryLedger = {
      loadAll: async () => [],
      loadKeys: async () => new Set<string>(),
      add: async () => { throw new Error("disk full"); },
      remove: async () => {},
      replace: async () => { throw new Error("disk full"); },
    };
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return { postId: "p" }; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // 2, not 1, because both rooms are delivered — the point is that neither is counted as failed.
    expect(res).toEqual(result({ sent: 2 }));
    expect(sends).toBe(2);
  });

  it("sends only the item(s) named by the ids filter", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    const { ledger, added } = fakeLedger();
    const sender = okSender("telegram");
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({
      targets: ["telegram"],
      ids: new Set(["x:2"]),
    });
    expect(res).toEqual(result({ sent: 2 })); // one item × two rooms
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
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    // Still 1: the limit is a property of the rendering, so it is counted once, not once per room.
    // The reason travels with it: the board's [발송] answers 400 with this text, and "an over-limit
    // segment" is the one failure the operator can actually fix (by editing the rendering).
    expect(res).toEqual(
      result({
        failed: 1,
        failures: [{ key: "x:1:announcement", error: "a segment exceeds the telegram limit — edit the rendering" }],
      }),
    );
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
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, async (e) => {
      archived.push(e);
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ sent: 2 }));
    // One archive entry per send, each naming its own room. The archivers `upload()` rather than
    // `update()`, so two entries that differ only in message id would otherwise land in the Drive
    // `sent/` folder under one name — see sentFileName.
    // `withCta`, because the archive records what the room received: this is a 공지, and a 공지 goes
    // out with its X link. The CTA describe at the bottom of this file owns that behaviour.
    const entry = { itemId: "x:1", type: "announcement", channel: "telegram", text: withCta("공지1"), postId: "p9", url: "u9", sentAt: expect.any(String) };
    expect(archived).toEqual([
      { ...entry, outletId: "tg-community" },
      { ...entry, outletId: "tg-dev" },
    ]);
  });

  it("does not archive a skipped (already-sent) rendering", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger(bothTelegramRooms());
    let archives = 0;
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(), undefined, async () => {
      archives++;
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ skipped: 2 }));
    expect(archives).toBe(0);
  });

  it("a best-effort archive failure does not fail the send", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(), undefined, async () => {
      throw new Error("disk full");
    }, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ sent: 2 }));
    expect(added.map((e) => e.itemId)).toEqual(["x:1", "x:1"]); // send + ledger stood; only the archive failed
  });

  it("reads photos from the rendering text and passes them to the sender", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "본문\n\n![](https://pbs.twimg.com/media/a.jpg)" })]);
    const { ledger } = fakeLedger();
    const got: { photos?: string[]; segments: string[] }[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push({ photos: req.photos, segments: req.segments }); return { postId: "1" }; } };
    await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });
    expect(got).toHaveLength(1); // x-post is the channel's only room
    expect(got[0].photos).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
    expect(got[0].segments.join("")).not.toContain("![("); // marker stripped from delivered text
    expect(got[0].segments.join("")).toContain("본문");
  });

  it("sends a marker-free rendering with photos: []", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "그냥 텍스트" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram", send: async (req) => { got.push(req.photos); return { postId: "p" }; } };
    await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(got).toEqual([[], []]); // one per auto Telegram room
  });

  it("a [영상]-only rendering sends text-only (photos: []) and does not throw", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "영상 트윗\n\n[영상]" })]);
    const { ledger } = fakeLedger();
    const got: { photos?: string[]; video?: string }[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push({ photos: req.photos, video: req.video }); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });
    expect(res.sent).toBe(1);
    expect(got[0].photos).toEqual([]);
    // A marker with no url is not an upload: there is nothing to upload. See the video-attachment
    // describe below for why those markers exist and always will.
    expect(got[0].video).toBeUndefined();
  });

  it("fail-fasts an over-280 x rendering at the default (standard) limit", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sender = okSender("x");
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });
    expect(res).toEqual(
      result({ failed: 1, failures: [{ key: "x:1:announcement", error: "a segment exceeds the x limit — edit the rendering" }] }),
    );
  });

  it("sends an over-280 x rendering when xMaxWeighted is 25000 (Premium)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sent: string[][] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { sent.push(req.segments); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations(), undefined, undefined, undefined, 25000).run({ targets: ["x"] });
    expect(res).toEqual(result({ sent: 1 }));
    expect(sent[0][0]).toBe("가".repeat(150));
  });

  it("sends one message per auto outlet on the channel, and skips manual ones", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sent: { chatId?: string }[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push({ chatId: req.chatId }); return { postId: "m1", url: "u" }; } };
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(res.sent).toBe(2); // tg-community + tg-dev; tg-kol and tg-blockchain are manual
    expect(sent.map((s) => s.chatId).sort()).toEqual(["-100111", "-100222"]);
    expect((await ledger.loadKeys()).size).toBe(2);
  });

  it("reports an auto outlet with no chat id as unconfigured — not failed — and still sends to the others", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    const { ledger } = fakeLedger();
    // A half-configured `.env`: 커뮤니티's id is set and 데브방's is not, so the map holds one room.
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, { "tg-community": "-100111" }).run({ targets: ["telegram"] });

    // Still counted and named — a room that received nothing must show up in the totals — but not
    // as `failed`: an unset room id is a setup step the operator has not taken, not a broken send,
    // and `failed N` growing with the backlog on every run reads as breakage.
    expect(res).toEqual(result({ sent: 1, unconfigured: 1, unconfiguredEnv: ["TELEGRAM_CHAT_ID_DEV"] }));
    // Nothing ledgered for the unconfigured room, so a rerun after fixing .env delivers only it.
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  it("warns once per unconfigured room, not once per rendering", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", text: "본문" }),
      rendering({ itemId: "x:2", channel: "telegram", text: "본문" }),
    ]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    // 커뮤니티 has history (so the first-delivery guard is not what is being measured here);
    // 데브방 has no chat id at all.
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:0", outletId: "tg-community" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, { "tg-community": "-100111" }).run({ targets: ["telegram"] });

    expect(res).toEqual(result({ sent: 2, unconfigured: 1, unconfiguredEnv: ["TELEGRAM_CHAT_ID_DEV"] }));
    // One line for the room, however many renderings were waiting for it. An unconfigured room is
    // also a never-delivered room, so it must be reported as unconfigured rather than withheld.
    const devWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("TELEGRAM_CHAT_ID_DEV"));
    expect(devWarnings).toHaveLength(1);
    expect(devWarnings[0]).toContain("맨틀 한국 데브방");
  });

  it("records each room's send under its own room, so one room's history cannot overwrite the other's", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => ({ postId: req.chatId === "-100111" ? "m1" : "m2" }) };
    const { ledger } = fakeLedger();
    const recorded: PublishRecord[] = [];
    await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), async (r) => { recorded.push(r); }, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(recorded.map((r) => [r.outletId, r.postId])).toEqual([["tg-community", "m1"], ["tg-dev", "m2"]]);
    expect(recorded.every((r) => r.channel === "telegram")).toBe(true); // channel is still recorded, it is just not the key
  });

  it("does not re-send a room already in the ledger, but still sends its sibling room", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sent: (string | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push(req.chatId); return { postId: "m1" }; } };
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:1", outletId: "tg-community", at: "T" })]);
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(res.sent).toBe(1);
    expect(res.skipped).toBe(1);
    expect(sent).toEqual(["-100222"]); // only 데브방; 커뮤니티 was already delivered
    expect([...(await ledger.loadKeys())].sort()).toEqual(["x:1:announcement:tg-community", "x:1:announcement:tg-dev"]);
  });

  it("restricts to the rooms named by --outlets", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"], outletIds: ["tg-dev"] });

    expect(res.sent).toBe(1);
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-dev"]);
  });

  it("restricts to the types named by the selector, leaving the item's other copy unsent", async () => {
    // The board sends one row at a time. Both of these are approved for the same rooms, so without
    // a type filter clicking [발송] on 공지 would also push 해설 into the live group.
    const store = fakeStore([
      rendering({ itemId: "x:1", type: "announcement", channel: "telegram", text: "공지" }),
      rendering({ itemId: "x:1", type: "explainer", channel: "telegram", text: "해설" }),
    ]);
    const sender: ChannelSender = { name: "telegram-bot", send: async () => ({ postId: "m1" }) };
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({
      targets: ["telegram"], types: ["announcement"], outletIds: ["tg-dev"],
    });

    expect(res.sent).toBe(1);
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-dev"]);
  });

  it("sends an approved x rendering once — Articles ship from the translation, not from here", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", type: "x", channel: "x", text: "트윗" })]);
    let sends = 0;
    const sender: ChannelSender = { name: "typefully", send: async () => { sends++; return { postId: "1" }; } };
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    // One send, because the X channel has one room. The account's other surface, X Articles, is
    // posted by `send:x-article` from the translation — putting the same copy out twice is what this
    // pins against, and it is why that surface is not registered as a room.
    expect(sends).toBe(1);
    expect(res).toEqual(result({ sent: 1 }));
    expect(added.map((e) => e.outletId)).toEqual(["x-post"]);
  });

  it("sends to a room whose only ledger row was dropped", async () => {
    // A dropped row means the draft was deleted before it published: nothing reached the room, so
    // withholding here would strand it forever — the opposite of what retiring the row is for.
    const store = fakeStore([rendering({ itemId: "x:1", type: "x", channel: "x", text: "트윗" })]);
    const { ledger, added } = fakeLedger([
      { itemId: "x:1", type: "x", outletId: "x-post", status: "dropped", at: "T0", by: "auto" },
    ]);
    let sends = 0;
    const sender: ChannelSender = { name: "typefully", send: async () => { sends++; return { postId: "2" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(sends).toBe(1);
    expect(res).toEqual(result({ sent: 1 }));
    expect(added.map((e) => [e.outletId, e.status])).toEqual([["x-post", "sent"]]);
  });
});

/**
 * The account can publish 15 posts a month through Typefully, and nothing checked that before this
 * gate existed. It has to be all-or-nothing per run (a partial batch leaves an operator
 * reconstructing how far it got from a room-by-room ledger) and it has to not count as `failed` (an
 * account at its plan's ceiling is behaving as sold, not broken).
 */
describe("SendChannels — publishing quota gate", () => {
  /** A fully-shaped Headroom for tests that don't care about in-flight rows. */
  const headroomOf = (remaining: number): Headroom => ({
    used: 15 - remaining, remaining, inFlight: 0, available: remaining, resetsAt: "2026-08-01T00:00:00+09:00",
  });

  /** One X rendering, approved for the one auto X room (x-post), plus the headroom reader as the 12th argument. */
  function sendChannelsWithQuota(headroom: () => Promise<Headroom>) {
    const store = fakeStore([rendering({ itemId: "x:1", type: "x", channel: "x", status: "approved" })]);
    const { ledger } = fakeLedger();
    return new SendChannels(
      store, { telegram: undefined, x: okSender("x") }, ledger, fakeTranslations(),
      undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS, undefined, headroom,
    ).run({ targets: ["x"] });
  }

  /** One X rendering and one Telegram rendering, with only tg-community configured so a telegram send counts as 1. */
  function sendChannelsWithBothChannels(headroom: () => Promise<Headroom>) {
    const store = fakeStore([
      rendering({ itemId: "x:1", type: "x", channel: "x", status: "approved" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "approved" }),
    ]);
    const { ledger } = fakeLedger();
    return new SendChannels(
      store, { telegram: okSender("telegram"), x: okSender("x") }, ledger, fakeTranslations(),
      undefined, undefined, undefined, undefined, outletsForChannel, { "tg-community": "-100111" }, undefined, headroom,
    ).run({ targets: ["telegram", "x"] });
  }

  /** No X rendering at all, so the batch never needs an X send and the gate must stay silent. */
  function sendChannelsTelegramOnly(headroom: () => Promise<Headroom>) {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", status: "approved" })]);
    const { ledger } = fakeLedger();
    return new SendChannels(
      store, { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(),
      undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS, undefined, headroom,
    ).run({ targets: ["telegram"] });
  }

  it("blocks every X room when the batch needs more than the quota allows", async () => {
    const result = await sendChannelsWithQuota(async () => headroomOf(0));
    expect(result.sent).toBe(0);
    // A quota refusal is an account state, not a fault — `failed` must stay clean.
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.quotaBlocked).toEqual({ needed: 1, available: 0, resetsAt: "2026-08-01T00:00:00+09:00" });
  });

  it("sends normally when the quota covers the batch", async () => {
    const result = await sendChannelsWithQuota(async () => headroomOf(6));
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  // The gate compares `needed > available`, not `>=` — a batch that exactly exhausts the remaining
  // headroom must still send. This run needs exactly 1 (one X rendering, one auto X room).
  it("sends when the batch needs exactly the headroom available (boundary)", async () => {
    const result = await sendChannelsWithQuota(async () => headroomOf(1));
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  /**
   * A draft created two minutes ago has not published yet, so it is in neither `used` nor a lower
   * `remaining`. Without this term two runs inside the scheduling window each see the same headroom
   * and together overshoot the account's monthly ceiling.
   *
   * Wired through the real `makeReadHeadroom` (not a hand-computed `available`) so this proves the
   * in-flight arithmetic through the same reader production uses — the gate itself no longer computes
   * `inFlight` at all, so a hand-rolled `Headroom` here would prove nothing about that arithmetic.
   */
  it("counts rows still awaiting publish against the remaining quota", async () => {
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:9", outletId: "x-post", postId: "10104901" })]);
    const headroom = makeReadHeadroom(ledger, { loadAll: async () => [] }, {
      readQuota: async () => ({ used: 14, remaining: 1, resetsAt: "2026-08-01T00:00:00+09:00" }),
      loadConfig: () => ({ apiKey: "K", socialSetId: "42" }),
    });
    const store = fakeStore([rendering({ itemId: "x:1", type: "x", channel: "x", status: "approved" })]);
    const result = await new SendChannels(
      store, { telegram: undefined, x: okSender("x") }, ledger, fakeTranslations(),
      undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS, undefined, headroom,
    ).run({ targets: ["x"] });
    expect(result.sent).toBe(0);
    expect(result.quotaBlocked).toEqual({ needed: 1, available: 0, resetsAt: "2026-08-01T00:00:00+09:00" });
  });

  it("leaves telegram rooms alone when X is over quota", async () => {
    const result = await sendChannelsWithBothChannels(async () => headroomOf(0));
    expect(result.quotaBlocked).toBeDefined();
    expect(result.sent).toBe(1); // the telegram room
  });

  // A monitoring call must never become a new way for delivery to fail.
  it("sends anyway when the quota lookup itself throws", async () => {
    const result = await sendChannelsWithQuota(async () => { throw new Error("network down"); });
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  it("never calls the quota reader when the batch has no X rooms", async () => {
    let called = 0;
    await sendChannelsTelegramOnly(async () => { called += 1; return headroomOf(15); });
    expect(called).toBe(0);
  });
});

/**
 * `renderings.json` is never pruned and a rendering stays `approved` after it is sent, so the whole
 * approved history is permanently "pending" for a room that has no ledger rows. Configuring a room
 * after weeks of operation would therefore post the entire backlog into a live group in one go —
 * silently, on an ordinary `pnpm send:channels`.
 */
describe("SendChannels first-delivery guard", () => {
  afterEach(() => vi.restoreAllMocks());

  const backlog = () => fakeStore([
    rendering({ itemId: "x:1", channel: "telegram", text: "본문1" }),
    rendering({ itemId: "x:2", channel: "telegram", text: "본문2" }),
    rendering({ itemId: "x:3", channel: "telegram", text: "본문3" }),
  ]);
  /** 커뮤니티 has been receiving all along; 데브방's chat id was only just added to `.env`. */
  const communityOnlyHistory = () => fakeLedger([
    sentEntry({ itemId: "x:1", outletId: "tg-community" }),
    sentEntry({ itemId: "x:2", outletId: "tg-community" }),
    sentEntry({ itemId: "x:3", outletId: "tg-community" }),
  ]);

  it("withholds the whole backlog from a never-delivered room, and says how to proceed", async () => {
    const sent: (string | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push(req.chatId); return { postId: "m1" }; } };
    const { ledger } = communityOnlyHistory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(backlog(), { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(sent).toEqual([]); // 데브방 received nothing; 커뮤니티 had already had all three
    expect(res).toEqual(result({ skipped: 3, withheld: 3 }));
    expect([...(await ledger.loadKeys())]).toHaveLength(3); // nothing new ledgered
    const withheldWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("tg-dev"));
    expect(withheldWarnings).toHaveLength(1); // once for the room, not once per rendering
    expect(withheldWarnings[0]).toContain("맨틀 한국 데브방");
    expect(withheldWarnings[0]).toContain("3"); // the count, so the operator sees the size of it
    expect(withheldWarnings[0]).toContain("--outlets tg-dev");
  });

  it("delivers that backlog once the room is named with --outlets", async () => {
    const sent: (string | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push(req.chatId); return { postId: "m1" }; } };
    const { ledger } = communityOnlyHistory();
    const res = await new SendChannels(backlog(), { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"], outletIds: ["tg-dev"] });

    expect(res).toEqual(result({ sent: 3 }));
    expect(sent).toEqual(["-100222", "-100222", "-100222"]);
  });

  it("does not withhold a single pending rendering — one message is not a backlog", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "본문" })]);
    const { ledger } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ sent: 2 }));
  });

  it("does not withhold a room that has delivered before, however long the backlog", async () => {
    const { ledger } = fakeLedger([
      sentEntry({ itemId: "x:0", outletId: "tg-community" }),
      sentEntry({ itemId: "x:0", outletId: "tg-dev" }),
    ]);
    const res = await new SendChannels(backlog(), { telegram: okSender("telegram"), x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });
    expect(res).toEqual(result({ sent: 6 })); // 3 renderings × 2 rooms
  });

  /**
   * REGRESSION. `everDelivered` is the *second* reader of "has anything ever reached this room" —
   * `already` above is the first — and only the first was routed through `deliveredToRoom` when
   * `dropped` was introduced. A `dropped` row is a scheduled draft deleted before it published, i.e.
   * a room that provably received NOTHING; counting it as history lifted this guard on the strength
   * of a delivery that never happened, and the whole approved backlog went into a live room.
   *
   * One retired row is all it takes, which is exactly what a first-ever X send that Typefully never
   * published leaves behind.
   */
  it("still withholds the backlog from a room whose only ledger row is dropped", async () => {
    const sent: (string | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { sent.push(req.chatId); return { postId: "m1" }; } };
    const { ledger } = fakeLedger([
      sentEntry({ itemId: "x:1", outletId: "tg-community" }),
      sentEntry({ itemId: "x:2", outletId: "tg-community" }),
      sentEntry({ itemId: "x:3", outletId: "tg-community" }),
      // 데브방's one and only row — retired, so this room has never actually received anything.
      sentEntry({ itemId: "x:1", outletId: "tg-dev", status: "dropped" }),
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(backlog(), { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    expect(sent).toEqual([]); // THE assertion: three live posts into 데브방 is what the bug did
    expect(res).toEqual(result({ skipped: 3, withheld: 3 }));
  });
});

/**
 * A forked room is the whole point of the outlet layer: the reviewer edited that room's copy, so
 * that room must receive *its* copy and carry *its own* approval. Sending the group text to a room
 * that has its own is unrecoverable — the ledger records the room as `sent`, and a `sent` row can
 * never be unmarked.
 */
describe("SendChannels — per-room overrides", () => {
  function capture() {
    const posts: { chatId?: string; text: string }[] = [];
    const sender: ChannelSender = {
      name: "telegram-bot",
      send: async (req) => {
        posts.push({ chatId: req.chatId, text: req.segments.join("\n") });
        return { postId: "p" };
      },
    };
    return { posts, sender };
  }
  /** chatId → text, so a test names the room rather than a send index. */
  const byRoom = (posts: { chatId?: string; text: string }[]) =>
    Object.fromEntries(posts.map((p) => [p.chatId === "-100111" ? "tg-community" : "tg-dev", p.text]));

  const groupText = "공통 공지";
  const approvedGroup = () => fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: groupText, status: "approved" })]);

  it("sends the fork's own text to the forked room, and the group text to the rest", async () => {
    const { posts, sender } = capture();
    const { ledger } = fakeLedger();
    const archived: string[] = [];
    const res = await new SendChannels(
      approvedGroup(), { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined,
      async (e) => { archived.push(e.text); }, () => "T", undefined, outletsForChannel, TG_CHAT_IDS,
      fakeOverrides([fork({ outletId: "tg-dev", text: "데브방 전용 공지", status: "approved" })]),
    ).run({ targets: ["telegram"] });

    expect(res.sent).toBe(2);
    // `withCta` on both: a fork is still a 공지, so the forked room gets its own copy AND the link.
    expect(byRoom(posts)).toEqual({ "tg-community": withCta(groupText), "tg-dev": withCta("데브방 전용 공지") });
    // The archive records what the room received, not what the group said.
    expect(archived.sort()).toEqual([withCta(groupText), withCta("데브방 전용 공지")].sort());
  });

  it("withholds a room whose fork is still rendered, even under an approved group", async () => {
    const { posts, sender } = capture();
    const { ledger } = fakeLedger();
    const res = await new SendChannels(
      approvedGroup(), { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T",
      undefined, outletsForChannel, TG_CHAT_IDS,
      fakeOverrides([fork({ outletId: "tg-dev", text: "아직 검수 전", status: "rendered" })]),
    ).run({ targets: ["telegram"] });

    // The group's approval does not cover a fork made after it — that text was never reviewed.
    expect(res.sent).toBe(1);
    expect(byRoom(posts)).toEqual({ "tg-community": withCta(groupText) });
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  it("sends an approved fork even when the group itself is still rendered", async () => {
    const { posts, sender } = capture();
    const { ledger } = fakeLedger();
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: groupText, status: "rendered" })]);
    const res = await new SendChannels(
      store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, () => "T",
      undefined, outletsForChannel, TG_CHAT_IDS,
      fakeOverrides([fork({ outletId: "tg-dev", text: "데브방 전용 공지", status: "approved" })]),
    ).run({ targets: ["telegram"] });

    // A forked room carries its own review, so an unreviewed group cannot hold it back.
    expect(res.sent).toBe(1);
    expect(byRoom(posts)).toEqual({ "tg-dev": withCta("데브방 전용 공지") });
  });

  it("leaves an unforked room byte-identical to the no-override run", async () => {
    const withStore = capture();
    const withoutStore = capture();
    await new SendChannels(
      approvedGroup(), { telegram: withStore.sender, x: undefined }, fakeLedger().ledger, fakeTranslations(), undefined, undefined,
      () => "T", undefined, outletsForChannel, TG_CHAT_IDS, fakeOverrides([]),
    ).run({ targets: ["telegram"] });
    await new SendChannels(
      approvedGroup(), { telegram: withoutStore.sender, x: undefined }, fakeLedger().ledger, fakeTranslations(), undefined, undefined,
      () => "T", undefined, outletsForChannel, TG_CHAT_IDS,
    ).run({ targets: ["telegram"] });

    expect(withStore.posts).toEqual(withoutStore.posts);
    expect(byRoom(withStore.posts)).toEqual({ "tg-community": withCta(groupText), "tg-dev": withCta(groupText) });
  });
});

/**
 * The upstream half of the send gate. A rendering's own approval says a human read *this copy*; it
 * says nothing about whether the translation it descends from still stands. Withdrawing 1차
 * approval — or editing and re-approving it — used to leave every derived room sendable, so copy
 * built from text the team had since retracted could still go live with one click.
 */
describe("SendChannels — the source translation gate", () => {
  function capture() {
    const posts: { chatId?: string }[] = [];
    const sender: ChannelSender = { name: "telegram-bot", send: async (req) => { posts.push({ chatId: req.chatId }); return { postId: "p" }; } };
    return { posts, sender };
  }
  const approvedGroup = () => fakeStore([rendering({ itemId: "x:1", channel: "telegram", status: "approved" })]);
  const send = (translations: TranslationStore, store = approvedGroup()) => {
    const { posts, sender } = capture();
    const { ledger } = fakeLedger();
    const run = new SendChannels(store, { telegram: sender, x: undefined }, ledger, translations,
      undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS)
      .run({ targets: ["telegram"] });
    return { posts, run };
  };

  it("sends when the source is approved and older than the copy — the ordinary case", async () => {
    const { posts, run } = send(fakeTranslations());
    expect((await run).sent).toBe(2);
    expect(posts).toHaveLength(2);
  });

  /**
   * Every withhold below asserts the WHOLE result, not just `sent: 0`.
   *
   * Because this describe's renderings are 공지, "nothing was sent" is no longer a statement about
   * this gate on its own: the X-link CTA refuses a 공지 with no `postedUrl` and also leaves `sent`
   * at 0. A withhold by this gate is a *clean* zero — the room never became a candidate, so nothing
   * is `failed` and `failures` is empty — where the CTA refusal is `failed: 1` carrying its own
   * reason. Only the full result tells the two apart, and these tests exist to prove this one.
   */
  it("withholds every room when the source's approval was withdrawn", async () => {
    const { posts, run } = send(fakeTranslations([source("x:1", { status: "translated", approvedAt: undefined, postedUrl: X_URL })]));
    expect(await run).toEqual(result({}));
    expect(posts).toEqual([]);
  });

  /**
   * 승인 취소 → 원문 수정 → 재승인. The reviewer fixed the Korean and re-approved it, which is not a
   * statement about the converted copy — that copy still says what the old Korean said. Releasing
   * the rooms here would send it.
   */
  it("withholds copy that was approved BEFORE the source was re-approved", async () => {
    const reapproved = source("x:1", { approvedAt: "2026-07-28T00:00:00Z", postedUrl: X_URL }); // after COPY_APPROVED_AT
    const { posts, run } = send(fakeTranslations([reapproved]));
    expect(await run).toEqual(result({}));
    expect(posts).toEqual([]);
  });

  it("sends again once the copy is re-approved after the source", async () => {
    // `postedUrl` is spelled out on every row in this describe: these tests replace the suite's
    // default rows, and a telegram 공지 with no X post url never reaches the gate they are about.
    const reapproved = source("x:1", { approvedAt: "2026-07-28T00:00:00Z", postedUrl: X_URL });
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", approvedAt: "2026-07-28T00:00:01Z" })]);
    const { posts, run } = send(fakeTranslations([reapproved]), store);
    expect((await run).sent).toBe(2);
    expect(posts).toHaveLength(2);
  });

  /** A rendering whose translation is gone cannot be checked, so it must not be sent on trust. */
  it("withholds a room whose source translation is missing entirely", async () => {
    const { posts, run } = send(fakeTranslations([]));
    // The one row that cannot carry a `postedUrl` — there is no row. So the full result carries the
    // whole weight here: a missing translation must be withheld by THIS gate, silently and before
    // the item is ever a candidate. `failed: 1` with `X 게시물 URL이 없습니다` would mean the gate had
    // let it through and the CTA caught it instead — the same zero, reached the wrong way.
    expect(await run).toEqual(result({}));
    expect(posts).toEqual([]);
  });

  /**
   * The case the fork rule creates. `[포맷 다시]` regenerates the group from the new Korean but
   * leaves forks untouched by design, so after a source edit the group is current and the fork is
   * not — and both read `approved`. Only the stamps tell them apart, which is why `textFor` carries
   * the fork's own.
   */
  it("sends the regenerated group but holds back a fork left over from the older source", async () => {
    const reapproved = source("x:1", { approvedAt: "2026-07-28T00:00:00Z", postedUrl: X_URL });
    const regenerated = fakeStore([rendering({ itemId: "x:1", channel: "telegram", approvedAt: "2026-07-28T00:00:01Z" })]);
    const { posts, sender } = capture();
    const { ledger } = fakeLedger();
    const res = await new SendChannels(
      regenerated, { telegram: sender, x: undefined }, ledger, fakeTranslations([reapproved]),
      undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS,
      fakeOverrides([fork({ outletId: "tg-dev", approvedAt: COPY_APPROVED_AT })]), // stamped before the re-approval
    ).run({ targets: ["telegram"] });

    expect(res.sent).toBe(1);
    expect(posts.map((p) => p.chatId)).toEqual(["-100111"]); // 커뮤니티만 — 데브방은 잠긴 채
  });
});

describe("SendChannels — pinning", () => {
  it("passes the run's pin flag to the sender", async () => {
    const seen: boolean[] = [];
    const sender: ChannelSender = {
      name: "telegram",
      send: async (req) => { seen.push(req.pin === true); return { postId: "p", url: "u" }; },
    };
    await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, TG_CHAT_IDS, fakeOverrides(),
    ).run({ targets: ["telegram"], pin: true, outletIds: ["tg-community"] });
    expect(seen).toEqual([true]);
  });

  it("leaves pin absent when the run did not ask for it", async () => {
    const seen: unknown[] = [];
    const sender: ChannelSender = {
      name: "telegram",
      send: async (req) => { seen.push(req.pin); return { postId: "p", url: "u" }; },
    };
    await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, TG_CHAT_IDS, fakeOverrides(),
    ).run({ targets: ["telegram"], outletIds: ["tg-community"] });
    expect(seen).toEqual([undefined]);
  });

  /**
   * THE regression test of this change. A post that reached the room but could not be pinned is a
   * `sent` with a ledger row — anything else and the next run posts it again.
   */
  it("counts a send whose pin failed as sent, writes its ledger row, and reports the warning", async () => {
    const { ledger, added } = fakeLedger();
    const sender: ChannelSender = {
      name: "telegram",
      send: async () => ({ postId: "p", url: "u", warning: "글은 올라갔지만 고정하지 못했습니다 (not enough rights)" }),
    };
    const result: SendChannelsResult = await new SendChannels(
      fakeStore([rendering({})]), { telegram: sender, x: undefined },
      ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, TG_CHAT_IDS, fakeOverrides(),
    ).run({ targets: ["telegram"], pin: true, outletIds: ["tg-community"] });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ outletId: "tg-community", status: "sent" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].error).toContain("고정하지 못했습니다");
  });

  it("reports no warnings for an ordinary send", async () => {
    const result = await new SendChannels(
      fakeStore([rendering({})]), { telegram: okSender("telegram"), x: undefined },
      fakeLedger().ledger, fakeTranslations(), undefined, undefined, undefined, 280,
      outletsForChannel, TG_CHAT_IDS, fakeOverrides(),
    ).run({ targets: ["telegram"], outletIds: ["tg-community"] });
    expect(result.warnings).toEqual([]);
  });
});

/**
 * `[영상] <url>` carries a playable mp4 since the video-capture change; before it, the marker went
 * in bare. Both spellings are in the store forever — nothing re-derives stored text on read — so
 * every test here states which one it is about.
 */
const MP4 = "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/vPz8ankm0777GHP_.mp4";
const PHOTO = "https://pbs.twimg.com/media/a.jpg";

describe("SendChannels — video attachment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attaches the mp4 from `[영상] <url>` to the X send", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `영상 트윗\n\n[영상] ${MP4}` })]);
    const { ledger, added } = fakeLedger();
    const { sender, got } = capturingSender("x");
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(res).toEqual(result({ sent: 1 }));
    expect(got).toHaveLength(1);
    expect(got[0].video).toBe(MP4);
    expect(got[0].photos).toEqual([]);
    expect(got[0].segments.join("")).not.toContain("[영상]"); // marker stripped from delivered text
    expect(got[0].segments.join("")).toContain("영상 트윗");
    expect(added).toHaveLength(1); // a delivered video is an ordinary send: ledgered like any other
  });

  it("attaches the captured mp4 and still reports a sibling marker that has none", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `본문\n\n[영상] ${MP4}\n\n[영상]` })]);
    const { ledger } = fakeLedger();
    const { sender, got } = capturingSender("x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    // Only one of the two markers is attachable, so the "more than one video" guard does not fire:
    // there is no choice to make about which mp4 goes on the post.
    expect(res).toEqual(result({ sent: 1 }));
    expect(got[0].video).toBe(MP4);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("1 video") && m.includes("x:video-backfill"))).toBe(true);
  });

  it("sends a bare `[영상]` exactly as before: no upload, no failure, and a warning that says why", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "영상 트윗\n\n[영상]" })]);
    const { ledger, added } = fakeLedger();
    const { sender, got } = capturingSender("x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(res).toEqual(result({ sent: 1 }));
    expect(got[0].video).toBeUndefined();
    expect(added).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("x:1:announcement:x-post") && m.includes("1 video"))).toBe(true);
  });

  it("refuses an X rendering carrying both photos and a video, and does not ledger it", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `본문\n\n[사진](${PHOTO})\n\n[영상] ${MP4}` })]);
    const { ledger, added } = fakeLedger();
    const { sender, got } = capturingSender("x");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(got).toEqual([]); // refused before the sender is reached — nothing was posted
    expect(added).toEqual([]); // not ledgered, so a rerun retries once a human has split it
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual([{ key: "x:1:announcement", error: expect.stringContaining("photos and a video") }]);
  });

  it("refuses an X rendering carrying two playable videos", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `본문\n\n[영상] ${MP4}\n\n[영상] ${MP4}?2` })]);
    const { ledger, added } = fakeLedger();
    const { sender, got } = capturingSender("x");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(got).toEqual([]);
    expect(added).toEqual([]);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual([{ key: "x:1:announcement", error: expect.stringContaining("2 videos") }]);
  });

  it("does not refuse photos alongside a bare `[영상]`: nothing attachable, nothing X would reject", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `본문\n\n[사진](${PHOTO})\n\n[영상]` })]);
    const { ledger } = fakeLedger();
    const { sender, got } = capturingSender("x");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });

    expect(res).toEqual(result({ sent: 1 }));
    expect(got[0].photos).toEqual([PHOTO]);
    expect(got[0].video).toBeUndefined();
  });

  it("leaves Telegram untouched: no video on the request, no refusal, and a warning naming Telegram", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: `본문\n\n[사진](${PHOTO})\n\n[영상] ${MP4}` })]);
    const { ledger, added } = fakeLedger();
    const { sender, got } = capturingSender("telegram");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, fakeTranslations(), undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS).run({ targets: ["telegram"] });

    // Photos + a video is exactly what the X guard refuses; Telegram has no such rule and its
    // behaviour is unchanged — both rooms receive the photo post as they always did.
    expect(res).toEqual(result({ sent: 2 }));
    expect(added).toHaveLength(2);
    expect(got.map((g) => g.video)).toEqual([undefined, undefined]);
    expect(got.map((g) => g.photos)).toEqual([[PHOTO], [PHOTO]]);
    const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("video"));
    expect(messages).toHaveLength(2); // one per room
    expect(messages[0]).toContain("Telegram");
    expect(messages[0]).not.toContain("x:video-backfill"); // that remedy is about the X path
  });

  it("leaves a video-free X send byte-identical: video absent from the request", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: `본문\n\n[사진](${PHOTO})` })]);
    const { ledger } = fakeLedger();
    const seen: unknown[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { seen.push(req.video); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, fakeTranslations()).run({ targets: ["x"] });
    expect(res).toEqual(result({ sent: 1 }));
    expect(seen).toEqual([undefined]);
  });
});

/**
 * A 공지 exists to route the room back to @0xMantleKR's own post, and that URL does not exist when
 * the rendering is written — so the CTA is composed here, at send time, from whichever of the two
 * sources has the post (see `xLinkCta.ts`). Only Telegram reaches this path: `isSendable` admits
 * telegram and x, x takes no CTA, and every KakaoTalk room is pasted by a human from the board.
 */
describe("SendChannels — the 공지 X-link CTA", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The suite's ordinary telegram wiring, with only the translations and ledger left to a test. */
  const send = (sender: ChannelSender, translations: TranslationStore, ledger = fakeLedger().ledger, store = fakeStore([rendering({})])) =>
    new SendChannels(
      store, { telegram: sender, x: undefined }, ledger, translations,
      undefined, undefined, () => "T", undefined, outletsForChannel, TG_CHAT_IDS,
    ).run({ targets: ["telegram"] });

  it("appends the CTA to a telegram 공지, using the translation's posted url", async () => {
    const { sender, got } = capturingSender("telegram");
    const res = await send(sender, fakeTranslations([source("x:1", { postedUrl: X_URL })]));

    expect(res).toEqual(result({ sent: 2 }));
    // Both rooms, and the CTA is the last thing in the message — a link the reader scrolls past is
    // a link nobody follows. `<b>hi</b>` is the fixture's `**hi**` as emitTelegramBot spells it,
    // which is also what proves the CTA went through the emitter rather than around it.
    expect(got.map((g) => g.segments.join("\n"))).toEqual([withCta("<b>hi</b> everyone"), withCta("<b>hi</b> everyone")]);
  });

  it("does not append a CTA to a telegram 해설", async () => {
    const { sender, got } = capturingSender("telegram");
    const res = await send(sender, fakeTranslations([source("x:1", { postedUrl: X_URL })]), undefined, fakeStore([rendering({ type: "explainer" })]));

    expect(res).toEqual(result({ sent: 2 }));
    expect(got.every((g) => !g.segments.join("\n").includes("자세한 내용은 X에서"))).toBe(true);
  });

  it("does not append a CTA on the x channel — the post cannot link to itself", async () => {
    const { sender, got } = capturingSender("x");
    const res = await new SendChannels(
      fakeStore([rendering({ type: "x", channel: "x" })]), { telegram: undefined, x: sender },
      fakeLedger().ledger, fakeTranslations([source("x:1", { postedUrl: X_URL })]),
    ).run({ targets: ["x"] });

    expect(res).toEqual(result({ sent: 1 }));
    expect(got[0].segments.join("\n")).not.toContain("자세한 내용은 X에서");
  });

  /**
   * THE point of the change. A 공지 delivered without its link is a live post nobody can recall and
   * nobody would notice was wrong, so this refuses rather than sending a CTA-less body.
   */
  it("refuses to send a 공지 with no X post url, and does not reach the sender", async () => {
    const { sender, got } = capturingSender("telegram");
    const { ledger, added } = fakeLedger();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send(sender, fakeTranslations([source("x:1")]), ledger);

    // Once for the item, not once per room: the missing URL is a property of the item.
    expect(res).toEqual(result({
      failed: 1,
      failures: [{ key: "x:1:announcement", error: "X 게시물 URL이 없습니다 — X를 먼저 게시하세요" }],
    }));
    expect(got).toEqual([]);
    // Not ledgered, so the next run delivers it as soon as the post is up — the refusal costs a
    // rerun and nothing else.
    expect(added).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("tg-community, tg-dev"))).toBe(true);
  });

  /**
   * Where the refusal sits in `run()`, pinned. The CTA block is resolved *below*
   * `if (pending.length === 0) continue;`, and that ordering is not cosmetic: a 공지 every room has
   * already received still has no `postedUrl` if it was hand-posted and never reconciled, and
   * hoisting the block above that guard would report it as `failed` on every run from now until
   * someone reconciles a post that no longer needs reconciling. `failed` that grows with the
   * backlog and can never be worked off reads as breakage — the same reason `unconfigured` and
   * `quotaBlocked` are kept out of it.
   */
  it("does not refuse a 공지 that every room has already received", async () => {
    const { sender, got } = capturingSender("telegram");
    const { ledger, added } = fakeLedger(bothTelegramRooms());
    const res = await send(sender, fakeTranslations([source("x:1")]), ledger);

    // An ordinary skip, exactly as before this change: nothing left to send, so nothing to refuse.
    expect(res).toEqual(result({ skipped: 2 }));
    expect(got).toEqual([]);
    expect(added).toEqual([]);
  });

  it("takes the url from the x-post delivery row when the translation has none", async () => {
    const { sender, got } = capturingSender("telegram");
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:1", type: "x", outletId: "x-post", url: X_URL })]);
    const res = await send(sender, fakeTranslations([source("x:1")]), ledger);

    // A bot-sent X post is reconciled onto its delivery row, never onto the translation, so this is
    // the ordinary path for anything the pipeline posted itself.
    expect(res).toEqual(result({ sent: 2 }));
    expect(got[0].segments.join("\n")).toContain(X_URL);
  });

  it("does not accept a typefully share url as the X post url", async () => {
    const { sender, got } = capturingSender("telegram");
    // What `SendChannels` itself writes onto the row at send time: the draft editor's share link,
    // which only becomes an x.com url minutes later when Typefully publishes it.
    const { ledger } = fakeLedger([sentEntry({ itemId: "x:1", type: "x", outletId: "x-post", url: "https://typefully.com/t/abc" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send(sender, fakeTranslations([source("x:1")]), ledger);

    expect(res.failed).toBe(1);
    expect(got).toEqual([]); // linking the room to our own draft editor is worse than not sending
  });

  it("counts the CTA toward the telegram length limit", async () => {
    const { sender, got } = capturingSender("telegram");
    // The CTA is what pushes this over 4096 — the body alone fits with nothing to spare.
    const body = "가".repeat(4096 - CTA.length);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send(sender, fakeTranslations([source("x:1", { postedUrl: X_URL })]), undefined, fakeStore([rendering({ text: body })]));

    // Appended after `emit` instead of through it, this would have gone out at 4096+N and Telegram
    // would have 400'd it on every run forever.
    expect(res).toEqual(result({
      failed: 1,
      failures: [{ key: "x:1:announcement", error: "a segment exceeds the telegram limit — edit the rendering" }],
    }));
    expect(got).toEqual([]);
  });

  it("archives the text the room actually received, CTA included", async () => {
    const archived: string[] = [];
    const res = await new SendChannels(
      fakeStore([rendering({ text: "공지 본문" })]), { telegram: okSender("telegram"), x: undefined },
      fakeLedger().ledger, fakeTranslations([source("x:1", { postedUrl: X_URL })]),
      undefined, async (e) => { archived.push(e.text); }, () => "T", undefined, outletsForChannel, TG_CHAT_IDS,
    ).run({ targets: ["telegram"] });

    // The archive is the record of what went into the room. Archiving the pre-CTA body would make
    // it disagree with the live message the day someone goes looking for what was actually said.
    expect(res).toEqual(result({ sent: 2 }));
    expect(archived).toEqual([withCta("공지 본문"), withCta("공지 본문")]);
  });
});
