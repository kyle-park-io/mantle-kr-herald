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
import type { Headroom } from "../../src/cli/publishHeadroom";
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

  it("restores the row when the send throws", async () => {
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
