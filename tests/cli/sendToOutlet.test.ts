import { describe, it, expect } from "vitest";
import { makeSendToOutlet, type SendToOutletDeps } from "../../src/cli/sendToOutlet";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { OutletOverrideStore } from "../../src/ports/OutletOverrideStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import { deliveryKey, deliveredToRoom } from "../../src/domain/delivery/models";
import type { Translation } from "../../src/domain/translation/models";
import type { SendableChannel } from "../../src/domain/send/channels";
import type { Headroom } from "../../src/domain/send/headroom";
import { awaitingPublish } from "../../src/domain/send/awaitingPublish";
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
    draftLookup: undefined, // a required key with a nullable value — see `SendToOutletDeps`
    chatIds: () => TG_CHAT_IDS,
    xMaxWeighted: () => 280,
    senders: () => ({ telegram: undefined, x: undefined }),
    /**
     * No quota gate unless a test asks for one — but for an X *resend* this is not "no gate", and a
     * new test must not read it as one. The resend guard reads the quota either side of the cancel
     * to tell a real cancel from a publish that beat it, and a reader that answers `undefined` is an
     * UNREADABLE quota: such a test refuses, sends nothing, and retires the row's draft id. Any X
     * resend test wants an explicit `quotaSequence(...)` (which `sendableX` defaults to).
     */
    headroom: () => undefined,
    sleep: async () => {}, // the quota settle wait is real time in production; tests must not spend it
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
/** The `Headroom` the real reader would answer for a 15/month account at `used`, with `inFlight` open. */
const headroomAt = (used: number, inFlight: number): Headroom => ({
  remaining: 15 - used,
  used,
  inFlight,
  available: 15 - used - inFlight,
  resetsAt: "2026-08-01T00:00:00+09:00",
});

/**
 * A headroom reader that answers a different `used` on each successive call, so a test can stage
 * what the resend guard reads before and after the cancel. `undefined` in the sequence stands for a
 * quota read that failed. Anything past the end repeats the last value.
 *
 * `inFlight` defaults to 1 because that is what the real reader answers here: the guard runs before
 * the ledger `remove`, so the row being resent is itself still awaiting publish. It is also what
 * separates the guard's two proven-published messages — exactly one in-flight draft means an
 * increase in `used` cannot belong to a sibling.
 */
function quotaSequence(used: (number | undefined)[], inFlight = 1): SendToOutletDeps["headroom"] {
  let i = 0;
  return (targets: SendableChannel[]) =>
    targets.includes("x")
      ? async () => {
          const u = used[Math.min(i++, used.length - 1)];
          if (u === undefined) throw new Error("quota read failed");
          return headroomAt(u, inFlight);
        }
      : undefined;
}

/**
 * A quota that a NAMED EVENT moves, rather than one that moves on a fixed call index — so a test can
 * say "the publish landed while `published()` was in flight" and have the guard's own reads observe
 * it wherever they actually are.
 *
 * That is what pins WHERE the before-read is taken. A sequence cannot: it answers by call order, so
 * it reads the same either side of a hoist. This one bakes the increase into every read after
 * `publish()`, so a before-read placed too late sees it already included, both sides agree, and the
 * guard proceeds — which is the test failing.
 */
function movingQuota(inFlight = 1, start = 9) {
  const state = { used: start };
  const headroom: SendToOutletDeps["headroom"] = (targets: SendableChannel[]) =>
    targets.includes("x") ? async () => headroomAt(state.used, inFlight) : undefined;
  return { headroom, publish: () => { state.used += 1; } };
}

function sendableX(
  itemId: string,
  ledger: DeliveryLedger,
  draftLookup: DraftLookup | undefined,
  // Typefully being configured is what puts a draft lookup here at all, so the quota is readable
  // too; a still `used` is the ordinary case where nothing published while we cancelled.
  headroom: SendToOutletDeps["headroom"] = quotaSequence([9, 9]),
  // The guard's settle wait before the after-read. A no-op by default so tests do not spend it; a
  // test that is about the wait passes one that does something observable.
  sleep: SendToOutletDeps["sleep"] = async () => {},
) {
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
    headroom,
    sleep,
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

  it("refuses when the quota moved across the cancel — the original published while we were cancelling", async () => {
    // Typefully answers 204 to a DELETE whether it cancelled a queued draft or deleted the record of
    // one that just published (measured live 2026-07-30), so the cancel's own answer proves nothing.
    // A publish is charged at publication, so a `used` that moved is the proof.
    const previous = queuedRow("x:10", "draft-raced");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:10", ledger, lookup.lookup, quotaSequence([9, 10]));

    const result = await sendToOutlet("x:10", "x", "x-post", true);

    expect(counter.sends).toBe(0); // THE assertion: the original is live, a resend is the double post
    expect(result.sent).toBe(0);
    expect(result.error).toContain("취소하는 사이에 원본이 게시된 것으로 보입니다");
    // This row was the only draft in flight *that our ledgers know of*, so the increase cannot
    // belong to a sibling — as far as the count can see. (The ambiguous case is the next test.)
    expect(result.error).toContain("원장이 아는 한 그때 게시를 기다리던 예약은 이 글뿐이었습니다");
    // "계정에서 방금 올라간 글을 확인하세요" is not followable without something to match on, and the
    // row is about to lose its draft id — the one handle onto Typefully's own history.
    expect(result.error).toContain("draft-raced");

    // The row must survive in a shape no reconcile will retire: its draft 404s now, so `gone` would
    // read as "never published" and free a room whose post is live.
    const [row] = await ledger.loadAll();
    expect(row.status).toBe("sent");
    expect(row.postId).toBeUndefined();
    expect(awaitingPublish(row)).toBe(false);
    // The other half of the refusal, and the half an assertion on `status` alone walks past: the
    // room must still read as delivered. `deliveredToRoom` is what `loadKeys()`, `SendChannels`'
    // `already` and its first-delivery guard all ask, so a row that fell out of it is a room the
    // next batch run posts the duplicate into.
    expect(deliveredToRoom(row)).toBe(true);
    expect(await ledger.loadKeys()).toContain(deliveryKey(row));
  });

  it("says the increase may belong to a sibling when other drafts were pending too", async () => {
    // `used` is account-wide, and the one window this branch is reachable in is exactly when a
    // batch's sibling drafts publish. Refusing is still right — this post may be live — but telling
    // the operator to go and find it is a claim the evidence does not support.
    const previous = queuedRow("x:16", "draft-crowded");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:16", ledger, lookup.lookup, quotaSequence([9, 10], 3));

    const result = await sendToOutlet("x:16", "x", "x-post", true);

    expect(counter.sends).toBe(0); // ambiguous still refuses — a resend is the irreversible move
    expect(result.error).toContain("게시됐을 수 있습니다"); // hedged — the sole-draft case says "보입니다"
    expect(result.error).toContain("이 글 말고도 2건"); // itself excluded from the in-flight count
    expect(result.error).toContain("다른 글이 올라간 것일 수도 있습니다");
  });

  it("reads the quota BEFORE asking whether the draft published — a publish inside that lookup is caught too", async () => {
    /**
     * The window that has to be covered starts at the first thing acting on a state that can go
     * stale, which is `published()`, not the `DELETE`. `published()` is a full Typefully round trip
     * (plus up to ~3s more when `createTypefullyFetch` retries a 429/5xx), and a publish charged
     * inside it is already baked into a `used` read taken afterwards — both sides agree and the
     * resend goes out on top of a live post.
     *
     * So the quota here moves when `published()` is called, not on the Nth read: a before-read
     * hoisted above `published()` sees 9 → 10 and refuses; one taken below it sees 10 → 10 and
     * sends. Nothing else in this suite fails when the read moves back down.
     */
    const q = movingQuota();
    const previous = queuedRow("x:14", "draft-slow-lookup");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => { q.publish(); return { state: "scheduled" }; }, true);
    const { sendToOutlet, counter } = sendableX("x:14", ledger, lookup.lookup, q.headroom);

    const result = await sendToOutlet("x:14", "x", "x-post", true);

    expect(counter.sends).toBe(0); // THE assertion: it published during the lookup, so nothing may go out
    expect(result.error).toContain("취소하는 사이에 원본이 게시된 것으로 보입니다");
    const [row] = await ledger.loadAll();
    expect(row.postId).toBeUndefined();
  });

  it("lets the counter settle before reading it back — a publish charged just after the DELETE is caught", async () => {
    // The live run polled ~15s apart, so it proves the counter HAD moved by the time a url appeared,
    // not that it moves in the same instant. A read fired microseconds after the DELETE returns can
    // still be serving the old number, and "it did not move" is read as "nothing published".
    const q = movingQuota();
    const waited: number[] = [];
    const previous = queuedRow("x:15", "draft-lagging-counter");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:15", ledger, lookup.lookup, q.headroom, async (ms) => {
      waited.push(ms);
      q.publish(); // the counter catches up during the wait, which is the whole point of waiting
    });

    const result = await sendToOutlet("x:15", "x", "x-post", true);

    expect(counter.sends).toBe(0); // THE assertion: without the wait this reads as a clean cancel
    expect(result.error).toContain("취소하는 사이에 원본이 게시된 것으로 보입니다");
    expect(waited).toHaveLength(1); // once, between the cancel and the after-read
    expect(waited[0]).toBeGreaterThan(0); // a real wait, not a zero-length one
  });

  it("refuses when the BEFORE read failed — an unread quota on either side is not evidence", async () => {
    // The mirror of the next test, and the one nothing covered: with only the after-read checked,
    // a failed before-read compares `undefined > 10` (false), falls through both branches, and
    // sends. Both sides are load-bearing.
    const previous = queuedRow("x:17", "draft-before-blip");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:17", ledger, lookup.lookup, quotaSequence([undefined, 9]));

    const result = await sendToOutlet("x:17", "x", "x-post", true);

    expect(counter.sends).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.error).toContain("월간 발행 쿼터를 읽지 못했습니다");
    const [row] = await ledger.loadAll();
    expect(row.postId).toBeUndefined(); // retired for the same reason as below
  });

  it("refuses when the quota could not be read, retires the draft id, and lets a second 재발송 through", async () => {
    const previous = queuedRow("x:11", "draft-unknown");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    // The third value is the ordinary gate read on the second attempt below — by then the guard has
    // nothing to look up, so it does not read the quota at all.
    const { sendToOutlet, counter } = sendableX("x:11", ledger, lookup.lookup, quotaSequence([9, undefined, 9]));

    const result = await sendToOutlet("x:11", "x", "x-post", true);

    expect(counter.sends).toBe(0); // an unread quota is not evidence that nothing published
    expect(result.sent).toBe(0);
    expect(result.error).toContain("월간 발행 쿼터를 읽지 못했습니다");
    expect(result.error).toContain("draft-unknown"); // the correlation handle, named before it is dropped

    /**
     * NOT left holding the draft id. That draft 404s now, so `ReconcilePublished` would read `gone`,
     * retire the row to `dropped`, and `deliveredToRoom` would drop it from `loadKeys()` — the room
     * reopens and the next batch run sends the copy this call just refused to send. Under `serve`
     * that happens by itself within ~2 minutes, with no operator involved: the refusal would undo
     * itself.
     */
    const [row] = await ledger.loadAll();
    expect(row.status).toBe("sent");
    expect(row.postId).toBeUndefined();
    expect(awaitingPublish(row)).toBe(false);
    expect(deliveredToRoom(row)).toBe(true); // the room stays closed until a human decides otherwise

    // And the way out, which is what makes "assume it published" the recoverable direction: with no
    // draft id there is nothing left to race, so pressing 재발송 again sends. The refusal costs the
    // operator one more click, not a room.
    const second = await sendToOutlet("x:11", "x", "x-post", true);
    expect(second.sent).toBe(1);
    expect(counter.sends).toBe(1);
  });

  it("resends when `used` DROPPED across the cancel — a monthly reset is not a publish", async () => {
    // The quota resets on the 1st, and `used` goes down when it does. Only an increase is evidence
    // that something published; refusing on any change would strand a room over a calendar rollover.
    const ledger = fakeDeliveryLedger([queuedRow("x:18", "draft-month-turn")]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const { sendToOutlet, counter } = sendableX("x:18", ledger, lookup.lookup, quotaSequence([14, 0]));

    const result = await sendToOutlet("x:18", "x", "x-post", true);

    expect(lookup.cancels).toEqual(["draft-month-turn"]);
    expect(result.sent).toBe(1);
    expect(counter.sends).toBe(1);
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

// ---------------------------------------------------------------------------------------------
// What the ledger must say when the guard CANCELLED the queued original and the send then failed.
//
// All three restore sites used to write `previous` back verbatim: `status: "sent"` with `postId`
// pointing at the draft this code had just deleted. That row is a lie with three costs — the board
// paints `예약됨` for a draft that no longer exists, `awaitingPublish` keeps one of the fifteen
// monthly publishes reserved for it, and `deliveredToRoom` skips the room as already-delivered until
// some reconcile pass retires it (≤2 min under `serve`, never for a pure CLI run).
//
// `dropped` is what actually happened, and it frees both the room and the slot immediately.
//
// Every test below asserts the ledger contents, not just the error string: the error was already
// correct before the fix, and asserting on it alone passes straight through the bug.
// ---------------------------------------------------------------------------------------------

describe("makeSendToOutlet — a cancelled original is retired, not restored as sent", () => {
  const dropped = (previous: DeliveryEntry): DeliveryEntry => ({ ...previous, status: "dropped" });

  it("retires the row when the send is then refused for quota", async () => {
    const previous = queuedRow("x:20", "draft-q");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    let sends = 0;
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:20", type: "x", channel: "x" })]),
      translationStore: fakeTranslationStore([source("x:20")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: undefined, x: { name: "typefully", send: async () => { sends += 1; return { postId: "p" }; } } }),
      headroom: quotaHeadroom(0), // needs 1, has 0
      draftLookup: lookup.lookup,
    }));

    const result = await sendToOutlet("x:20", "x", "x-post", true);

    expect(result.sent).toBe(0);
    expect(result.error).toContain("쿼터");
    expect(sends).toBe(0);
    expect(lookup.cancels).toEqual(["draft-q"]); // the original really was taken out of the queue
    expect(await ledger.loadAll()).toEqual([dropped(previous)]);
  });

  it("retires the row when nothing is sent for any other reason", async () => {
    const previous = queuedRow("x:21", "draft-z");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([]), // the approved copy is gone by the time of the resend
      deliveryLedger: ledger,
      senders: () => ({ telegram: undefined, x: { name: "typefully", send: async () => ({ postId: "p" }) } }),
      draftLookup: lookup.lookup,
      headroom: quotaSequence([9, 9]), // the quota did not move: nothing published while we cancelled
    }));

    const result = await sendToOutlet("x:21", "x", "x-post", true);

    expect(result.sent).toBe(0);
    expect(result.error).toContain("no approved copy to send");
    expect(lookup.cancels).toEqual(["draft-z"]);
    expect(await ledger.loadAll()).toEqual([dropped(previous)]);
  });

  it("retires the row when the send path throws before completing", async () => {
    const previous = queuedRow("x:22", "draft-y");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([rendering({ itemId: "x:22", type: "x", channel: "x" })]),
      translationStore: fakeTranslationStore([source("x:22")]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: undefined, x: { name: "typefully", send: async () => ({ postId: "p" }) } }),
      recorder: async () => { throw new Error("recorder boom"); },
      draftLookup: lookup.lookup,
      headroom: quotaSequence([9, 9]), // the quota did not move: nothing published while we cancelled
    }));

    const result = await sendToOutlet("x:22", "x", "x-post", true);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toBe("recorder boom");
    expect(lookup.cancels).toEqual(["draft-y"]);
    expect(await ledger.loadAll()).toEqual([dropped(previous)]);
  });

  // The complement: nothing was cancelled, so the room still holds exactly what `previous` says it
  // does and the row must go back untouched. A fix that retired unconditionally would strand a real
  // Telegram post as `예약 취소됨` and offer to send it again.
  it("restores a telegram row verbatim — no draft was cancelled", async () => {
    const previous = sentRow({ itemId: "x:23", type: "announcement", outletId: "tg-community" });
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "scheduled" }), true);
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([]), // nothing to send → the zero-send restore
      deliveryLedger: ledger,
      senders: () => ({ telegram: okSender("telegram-bot"), x: undefined }),
      draftLookup: lookup.lookup,
    }));

    const result = await sendToOutlet("x:23", "announcement", "tg-community", true);

    expect(result.sent).toBe(0);
    expect(lookup.cancels).toEqual([]);
    expect(await ledger.loadAll()).toEqual([previous]); // still `sent`, still holding its t.me url
  });

  // `gone` reaches the same restore sites with `cancelled: false`: the draft was already deleted
  // before this call, so this code removed nothing — but the row is still describing a post the room
  // never received, which is what makes `previous` verbatim wrong to reason about from the outside.
  // Pinned as-is deliberately: retiring here would be a *separate* behaviour change (the row was
  // already stale on arrival, not made stale by this call), and this test exists so that change
  // cannot happen silently.
  it("restores a `gone` original verbatim — this call cancelled nothing", async () => {
    const previous = queuedRow("x:24", "draft-gone");
    const ledger = fakeDeliveryLedger([previous]);
    const lookup = fakeDraftLookup(async () => ({ state: "gone" }));
    const sendToOutlet = makeSendToOutlet(makeDeps({
      formattingStore: fakeFormattingStore([]),
      deliveryLedger: ledger,
      senders: () => ({ telegram: undefined, x: { name: "typefully", send: async () => ({ postId: "p" }) } }),
      draftLookup: lookup.lookup,
    }));

    await sendToOutlet("x:24", "x", "x-post", true);

    expect(lookup.cancels).toEqual([]);
    expect(await ledger.loadAll()).toEqual([previous]);
  });
});
