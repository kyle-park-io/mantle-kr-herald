import { describe, it, expect } from "vitest";
import { makeSendToOutlet, type SendToOutletDeps } from "../../src/cli/sendToOutlet";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { OutletOverrideStore } from "../../src/ports/OutletOverrideStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import { deliveryKey } from "../../src/domain/delivery/models";
import type { Translation } from "../../src/domain/translation/models";
import type { SendableChannel } from "../../src/domain/send/channels";
import type { Headroom } from "../../src/domain/send/headroom";
import type { DraftLookup } from "../../src/ports/DraftLookup";
import type { DraftState } from "../../src/domain/send/draftState";
import { outletById } from "../../src/domain/outlet/models";

// ---------------------------------------------------------------------------------------------
// Fakes, deliberately close cousins of tests/app/sendChannels.test.ts's — this suite drives the
// same SendChannels through the factory, not a reimplementation of it.
// ---------------------------------------------------------------------------------------------

function fakeFormattingStore(rows: ChannelRendering[]): FormattingStore {
  return { loadAll: async () => rows, upsert: async () => {}, listRenderedKeys: async () => new Set() };
}

/** A live array reference, so a test can inspect the ledger's contents after the call under test. */
function fakeDeliveryLedger(seed: DeliveryEntry[] = []): DeliveryLedger {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map(deliveryKey)),
    add: async (e: DeliveryEntry) => {
      rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(e)), e];
    },
    remove: async (key: string) => {
      rows = rows.filter((r) => deliveryKey(r) !== key);
    },
  };
}

function fakeTranslationStore(rows: Translation[]): TranslationStore {
  return { loadAll: async () => rows, upsert: async () => {}, listTranslatedIds: async () => new Set(rows.map((t) => t.itemId)) };
}

function fakeOverrideStore(): OutletOverrideStore {
  return { loadAll: async () => [], upsert: async () => {}, remove: async () => {} };
}

/** Shaped like `JsonXArticleLedger`, without importing the concrete adapter — only `loadAll` is read. */
function fakeArticleLedger(): { loadAll(): Promise<{ postId?: string; url?: string }[]> } {
  return { loadAll: async () => [] };
}

const TG_CHAT_IDS = { "tg-community": "-100111", "tg-dev": "-100222" };

const rendering = (o: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "x:1", type: "announcement", channel: "telegram", text: "본문", refined: false,
  createdAt: "2026-07-27T00:00:00Z", status: "approved", approvedAt: "2026-07-27T01:00:00Z", ...o,
});

/** An approved 1차 translation, stamped before `rendering`'s default `approvedAt` — the ordinary case. */
const source = (itemId: string, o: Partial<Translation> = {}): Translation => ({
  itemId, source: "x", sourceText: "src", koreanText: "ko",
  status: "approved", translatedAt: "2026-07-25T00:00:00Z", approvedAt: "2026-07-26T00:00:00Z", ...o,
});

const sentRow = (o: Partial<DeliveryEntry> = {}): DeliveryEntry => ({
  itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent",
  at: "2026-07-20T00:00:00Z", by: "auto", postId: "old-post", url: "https://t.me/old", senderName: "telegram-bot", ...o,
});

const okSender = (name: string, postId = "new-post", url = "https://t.me/new"): ChannelSender => ({
  name, send: async () => ({ postId, url }),
});
const throwingSender = (name: string, message = "boom"): ChannelSender => ({
  name, send: async () => { throw new Error(message); },
});

/** Every dep has a harmless, non-gating default; a test overrides only what it is about. */
function makeDeps(overrides: Partial<SendToOutletDeps> = {}): SendToOutletDeps {
  return {
    formattingStore: fakeFormattingStore([]),
    deliveryLedger: fakeDeliveryLedger([]),
    translationStore: fakeTranslationStore([]),
    overrideStore: fakeOverrideStore(),
    articleLedger: fakeArticleLedger(),
    chatIds: () => TG_CHAT_IDS,
    xMaxWeighted: () => 280,
    senders: () => ({ telegram: undefined, x: undefined }),
    headroom: () => undefined, // no quota gate unless a test asks for one
    recorder: async () => undefined,
    archiver: async () => undefined,
    ...overrides,
  };
}

/**
 * A `DraftLookup` that records what it was asked. `published` takes a thunk rather than a value so a
 * test can make the lookup throw — the case where the resend must refuse rather than guess.
 */
function fakeDraftLookup(published: () => Promise<DraftState>, cancelled = true) {
  const lookups: string[] = [];
  const cancels: string[] = [];
  const lookup: DraftLookup = {
    published: async (draftId) => { lookups.push(draftId); return published(); },
    cancel: async (draftId) => { cancels.push(draftId); return cancelled; },
  };
  return { lookup, lookups, cancels };
}

/** A headroom reader bound only to the "x" target — a stand-in for `headroomReader`'s own gating. */
function quotaHeadroom(available: number): SendToOutletDeps["headroom"] {
  const h: Headroom = { remaining: available, used: 15 - available, inFlight: 0, available, resetsAt: "2026-08-01T00:00:00+09:00" };
  return (targets: SendableChannel[]) => (targets.includes("x") ? async () => h : undefined);
}

describe("makeSendToOutlet — the resend ledger restore", () => {
  it("restores the row when the send is refused for quota", async () => {
    const previous = sentRow({ itemId: "x:1", type: "x", outletId: "x-post", postId: "draft-old", url: undefined, senderName: "typefully" });
    const ledger = fakeDeliveryLedger([previous]);
    let sends = 0;
    const sender = { name: "typefully", send: async () => { sends += 1; return { postId: "p" }; } };
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:1", type: "x", channel: "x" })]),
      translationStore: fakeTranslationStore([source("x:1")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: undefined, x: sender }),
      headroom: quotaHeadroom(0), // needs 1, has 0
    }));

    const result = await sendToOutlet("x:1", "x", "x-post", true);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.error).toContain("쿼터");
    expect(result.error).toContain("필요 1건");
    expect(result.error).toContain("잔여 0건");
    expect(sends).toBe(0); // the account-wide gate withheld it before the sender was ever touched
    expect(await ledger.loadAll()).toEqual([previous]); // the removed row is back, unchanged
  });

  // "Nothing sent for any other reason" is exercised here as "the approved copy is gone by the time
  // of the resend" — the room's chat id is resolved and it is not throwing, so this proves the
  // restore fires on the SendChannels-reported zero-send path, not just the quota or throw ones.
  it("restores the row when nothing is sent for any other reason", async () => {
    const previous = sentRow({ itemId: "x:2", type: "announcement", outletId: "tg-community" });
    const ledger = fakeDeliveryLedger([previous]);
    let sends = 0;
    const sender = { name: "telegram-bot", send: async () => { sends += 1; return { postId: "p" }; } };
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([]), // no approved copy at all for x:2/announcement/telegram
      deliveryLedger: ledger,
      senders: () => ({ telegram: sender, x: undefined }),
    }));

    const result = await sendToOutlet("x:2", "announcement", "tg-community", true);

    expect(result.sent).toBe(0);
    expect(result.error).toContain("no approved copy to send");
    expect(sends).toBe(0);
    expect(await ledger.loadAll()).toEqual([previous]);
  });

  // `SendChannels` catches every sender throw internally (`src/app/SendChannels.ts` wraps
  // `sender.send()` in its own try/catch and turns it into `failed += 1` / `failures.push(...)`) —
  // it never propagates out of `.run()`. So this exercises the `result.failed > 0` branch of the
  // *zero-send* restore (the same site the previous test hits), not the outer `catch` below. It is
  // kept because that reason branch is real and worth covering on its own; the outer catch gets its
  // own test next.
  it("restores the row when the sender fails", async () => {
    const previous = sentRow({ itemId: "x:3", type: "announcement", outletId: "tg-community" });
    const ledger = fakeDeliveryLedger([previous]);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:3" })]),
      translationStore: fakeTranslationStore([source("x:3")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: throwingSender("telegram-bot"), x: undefined }),
    }));

    const result = await sendToOutlet("x:3", "announcement", "tg-community", true);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toContain("boom");
    expect(await ledger.loadAll()).toEqual([previous]);
  });

  // The one restore site `SendChannels` cannot reach for us: something outside `.run()`'s own
  // per-room handling throws (here, the recorder dep, read via `Promise.all([makeRecorder(),
  // makeArchiver()])` inside the same `try`). This is what actually reaches the outer `catch` at
  // the bottom of `sendToOutlet.ts`, distinct from every other restore test in this file.
  it("restores the row when the send path throws before completing", async () => {
    const previous = sentRow({ itemId: "x:5", type: "announcement", outletId: "tg-community" });
    const ledger = fakeDeliveryLedger([previous]);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:5" })]),
      translationStore: fakeTranslationStore([source("x:5")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: okSender("telegram-bot"), x: undefined }),
      recorder: async () => { throw new Error("recorder boom"); },
    }));

    const result = await sendToOutlet("x:5", "announcement", "tg-community", true);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toBe("recorder boom");
    expect(await ledger.loadAll()).toEqual([previous]);
  });

  // The complement, and the one a careless fix breaks: a successful resend must leave exactly one
  // row, describing the NEW send — not the old one restored on top of it.
  it("does not re-add the previous row on a successful send", async () => {
    const previous = sentRow({ itemId: "x:4", type: "announcement", outletId: "tg-community", postId: "old-post", url: "https://t.me/old" });
    const ledger = fakeDeliveryLedger([previous]);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:4" })]),
      translationStore: fakeTranslationStore([source("x:4")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: okSender("telegram-bot", "new-post", "https://t.me/new"), x: undefined }),
    }));

    const result = await sendToOutlet("x:4", "announcement", "tg-community", true);

    expect(result.sent).toBe(1);
    expect(result.error).toBeUndefined();
    const key = deliveryKey({ itemId: "x:4", type: "announcement", outletId: "tg-community" });
    const rows = (await ledger.loadAll()).filter((r) => deliveryKey(r) === key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ postId: "new-post", url: "https://t.me/new" }); // the NEW send, not the old one
  });
});

describe("makeSendToOutlet — guards that return before any send", () => {
  it("rejects an unknown outlet", async () => {
    let sends = 0;
    const sendToOutlet = makeSendToOutlet(makeDeps({
      senders: () => ({ telegram: { name: "t", send: async () => { sends += 1; return {}; } }, x: undefined }),
    }));
    const result = await sendToOutlet("x:1", "announcement", "not-a-real-outlet");
    expect(result).toEqual({ sent: 0, failed: 0, error: "unknown outlet: not-a-real-outlet" });
    expect(sends).toBe(0);
  });

  it("rejects a room that is not posted by a bot", async () => {
    // tg-blockchain is `delivery: "manual"` — a human pastes it, `send:channels` never touches it.
    const outlet = outletById("tg-blockchain")!;
    let sends = 0;
    const sendToOutlet = makeSendToOutlet(makeDeps({
      senders: () => ({ telegram: { name: "t", send: async () => { sends += 1; return {}; } }, x: undefined }),
    }));
    const result = await sendToOutlet("x:1", "announcement", "tg-blockchain");
    expect(result).toEqual({
      sent: 0, failed: 0,
      error: `${outlet.label} (${outlet.id}) is not posted by a bot — copy the text, paste it, and tick 전달함`,
    });
    expect(sends).toBe(0);
  });

  it("rejects a room whose chat id env is unset", async () => {
    const outlet = outletById("tg-community")!;
    let sends = 0;
    const sendToOutlet = makeSendToOutlet(makeDeps({
      chatIds: () => ({}), // neither room configured
      senders: () => ({ telegram: { name: "t", send: async () => { sends += 1; return {}; } }, x: undefined }),
    }));
    const result = await sendToOutlet("x:1", "announcement", "tg-community");
    expect(result).toEqual({
      sent: 0, failed: 0,
      error: `${outlet.label} (${outlet.id}): ${outlet.chatIdEnv} is not set`,
    });
    expect(sends).toBe(0);
  });

  it("rejects a resend for a room nothing has been sent to", async () => {
    const outlet = outletById("tg-community")!;
    let sends = 0;
    const sendToOutlet = makeSendToOutlet(makeDeps({
      deliveryLedger: fakeDeliveryLedger([]), // nothing ledgered for this room at all
      senders: () => ({ telegram: { name: "t", send: async () => { sends += 1; return {}; } }, x: undefined }),
    }));
    const result = await sendToOutlet("x:1", "announcement", "tg-community", true);
    expect(result).toEqual({
      sent: 0, failed: 0,
      error: `${outlet.label} (${outlet.id}): nothing has been sent to this room yet`,
    });
    expect(sends).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The resend guard. An X send does not publish when it is made — it is scheduled through Typefully
// a couple of minutes out — so a resend inside that window used to schedule a SECOND draft while the
// first was still counting down: two live posts on a brand account, irreversibly, and two of the
// fifteen monthly publishes the gate had counted as one.
//
// Every refusal below asserts `counter.sends === 0`, not just the error string. An error message
// returned while the post goes out anyway is the exact failure this guard exists to prevent, and an
// assertion on the message alone would pass through it.
// ---------------------------------------------------------------------------------------------

/** A room whose ledger row holds a Typefully draft id and no x.com url — `awaitingPublish` is true. */
const queuedRow = (itemId: string, postId = "draft-777"): DeliveryEntry =>
  sentRow({ itemId, type: "x", outletId: "x-post", postId, url: undefined, senderName: "typefully" });

/**
 * Everything an X resend needs to actually go out: approved copy, an approved source, a working
 * sender, no quota gate. So `counter.sends` reads 1 whenever nothing refuses — which is what makes
 * `expect(counter.sends).toBe(0)` in the refusal tests mean something, and what the two proceeding
 * tests below assert directly.
 */
function sendableX(itemId: string, ledger: DeliveryLedger, draftLookup?: DraftLookup) {
  const counter = { sends: 0 };
  const sendToOutlet = makeSendToOutlet(makeDeps({
    formattingStore: fakeFormattingStore([rendering({ itemId, type: "x", channel: "x" })]),
    translationStore: fakeTranslationStore([source(itemId)]),
    deliveryLedger: ledger,
    senders: () => ({
      telegram: undefined,
      x: { name: "typefully", send: async () => { counter.sends += 1; return { postId: "draft-new" }; } },
    }),
    draftLookup,
  }));
  return { sendToOutlet, counter };
}

describe("makeSendToOutlet — a resend must not race the original's scheduled publish", () => {
  it("refuses a resend when the original has already published, and reconciles the row", async () => {
    const previous = queuedRow("x:6");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "published", xUrl: "https://x.com/a/status/777", xId: "777" }));
    const { sendToOutlet, counter } = sendableX("x:6", ledger, lookup.lookup);

    const result = await sendToOutlet("x:6", "x", "x-post", true);

    expect(counter.sends).toBe(0); // THE assertion: the original is live, so nothing may go out
    expect(result.sent).toBe(0);
    expect(result.error).toContain("이미 게시");
    expect(result.error).toContain("https://x.com/a/status/777");
    expect(lookup.cancels).toEqual([]); // a published draft cannot be cancelled
    // Updated in place, never removed: the board must stop showing 예약됨 for a post that is live.
    expect(await ledger.loadAll()).toEqual([{ ...previous, postId: "777", url: "https://x.com/a/status/777" }]);
  });

  it("cancels a still-scheduled original before resending", async () => {
    const ledger = fakeDeliveryLedger([queuedRow("x:7", "draft-abc")]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:7", ledger, lookup.lookup);

    const result = await sendToOutlet("x:7", "x", "x-post", true);

    expect(lookup.cancels).toEqual(["draft-abc"]); // the ORIGINAL draft id, not the new one
    expect(result.sent).toBe(1);
    expect(result.error).toBeUndefined();
    expect(counter.sends).toBe(1);
  });

  it("refuses the resend when cancelling fails", async () => {
    const previous = queuedRow("x:8", "draft-abc");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), false);
    const { sendToOutlet, counter } = sendableX("x:8", ledger, lookup.lookup);

    const result = await sendToOutlet("x:8", "x", "x-post", true);

    expect(counter.sends).toBe(0); // THE assertion: the original may still publish
    expect(result.sent).toBe(0);
    expect(lookup.cancels).toEqual(["draft-abc"]);
    expect(result.error).toContain("취소하지 못했습니다");
    expect(await ledger.loadAll()).toEqual([previous]); // the row the room is still described by
  });

  it("refuses the resend when the lookup itself throws", async () => {
    const previous = queuedRow("x:9");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => { throw new Error("ECONNRESET"); });
    const { sendToOutlet, counter } = sendableX("x:9", ledger, lookup.lookup);

    const result = await sendToOutlet("x:9", "x", "x-post", true);

    expect(counter.sends).toBe(0); // unknown is not "safe to send" — the reconcile can wait, this cannot
    expect(result.sent).toBe(0);
    expect(lookup.cancels).toEqual([]);
    expect(result.error).toContain("확인하지 못했습니다");
    expect(await ledger.loadAll()).toEqual([previous]);
  });

  it("resends without cancelling when the original draft is gone", async () => {
    const ledger = fakeDeliveryLedger([queuedRow("x:10")]);
    const lookup = fakeDraftLookup(async () => ({ state: "gone" }));
    const { sendToOutlet, counter } = sendableX("x:10", ledger, lookup.lookup);

    const result = await sendToOutlet("x:10", "x", "x-post", true);

    expect(lookup.cancels).toEqual([]); // nothing to cancel — it was already deleted
    expect(result.sent).toBe(1);
    expect(counter.sends).toBe(1);
  });

  it("does not consult Typefully when resending a telegram row", async () => {
    // Telegram publishes immediately and comes back with a t.me url, so `awaitingPublish` is false
    // and there is no queued draft to race. A round trip here would be a cost for nothing.
    const ledger = fakeDeliveryLedger([sentRow({ itemId: "x:11", type: "announcement", outletId: "tg-community" })]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }));
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:11" })]),
      translationStore: fakeTranslationStore([source("x:11")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: okSender("telegram-bot"), x: undefined }),
      draftLookup: lookup.lookup,
    }));

    const result = await sendToOutlet("x:11", "announcement", "tg-community", true);

    expect(lookup.lookups).toEqual([]);
    expect(lookup.cancels).toEqual([]);
    expect(result.sent).toBe(1);
  });

  it("does not consult Typefully for an X row already carrying its x.com url", async () => {
    // Reconciled rows describe a post that is already live; there is no draft left in the queue.
    const ledger = fakeDeliveryLedger([
      sentRow({ itemId: "x:12", type: "x", outletId: "x-post", postId: "777", url: "https://x.com/a/status/777", senderName: "typefully" }),
    ]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }));
    const { sendToOutlet, counter } = sendableX("x:12", ledger, lookup.lookup);

    const result = await sendToOutlet("x:12", "x", "x-post", true);

    expect(lookup.lookups).toEqual([]);
    expect(result.sent).toBe(1);
    expect(counter.sends).toBe(1);
  });

  it("does not consult Typefully on a first send — the guard is a resend-only cost", async () => {
    const lookup = fakeDraftLookup(async () => ({ state: "published", xUrl: "https://x.com/a/status/1", xId: "1" }));
    const { sendToOutlet, counter } = sendableX("x:13", fakeDeliveryLedger([]), lookup.lookup);

    const result = await sendToOutlet("x:13", "x", "x-post", false);

    expect(lookup.lookups).toEqual([]);
    expect(result.sent).toBe(1);
    expect(counter.sends).toBe(1);
  });
});
