import type { FormattingStore } from "../ports/FormattingStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { SendableChannel, SentArchiveEntry } from "../domain/send/channels";
import { DELIVERY_DESTINATION } from "../domain/send/channels";
import { deliveryKey } from "../domain/delivery/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { DeliveryEntry } from "../domain/delivery/models";
import type { Outlet } from "../domain/outlet/models";
import { deliveredByChannelSender, outletsForChannel } from "../domain/outlet/models";
import type { ResolvedText } from "../domain/outlet/override";
import { overrideKey, textFor } from "../domain/outlet/override";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";
import type { TranslationStore } from "../ports/TranslationStore";
import { sendBlock } from "../domain/send/sendBlock";
import { emit } from "../domain/formatting/emitters";
import { matchesItemId } from "../domain/itemId";
import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";
import type { PublishRecord } from "../domain/sheet/models";
import { extractMedia } from "../domain/media/sourceMedia";
import type { Headroom } from "../domain/send/headroom";

export type Recorder = (rec: PublishRecord) => Promise<void>;
export type Archiver = (entry: SentArchiveEntry) => Promise<void>;

export interface SendChannelsInput {
  targets: SendableChannel[];
  ids?: Set<string>;
  /**
   * Restrict delivery to these conversion types. Absent = every approved rendering of the item.
   * The board's per-row [발송] needs it: one item can hold an approved `announcement` and an
   * approved `explainer` for the same room, and sending the row the operator clicked must not also
   * push the other one into a live group.
   */
  types?: string[];
  /** Restrict delivery to these outlet ids (`--outlets`). Absent = every auto room on the channel. */
  outletIds?: string[];
}
export interface SendChannelsResult {
  sent: number;
  skipped: number;
  failed: number;
  /**
   * Rooms that declare a `chatIdEnv` with no value — counted once per room, never per rendering,
   * and deliberately not `failed`: on the documented legacy-only upgrade path an unconfigured room
   * is an install behaving exactly as intended, and a forever-growing `failed N` reads as breakage.
   */
  unconfigured: number;
  /** The env vars of those rooms, so the caller can name them in its summary. */
  unconfiguredEnv: string[];
  /** Renderings withheld from a never-delivered room by the first-delivery guard. */
  withheld: number;
  /**
   * Set when the account's monthly Typefully publishing quota could not cover this batch, in which
   * case **no** X room was delivered to. Deliberately not `failed`, for the same reason
   * `unconfigured` is not: an account at its plan's ceiling is behaving exactly as intended, and a
   * `failed N` that grows every run reads as breakage. The reason is carried here and nowhere else —
   * duplicating it into `failures` would report one event in two vocabularies.
   */
  quotaBlocked?: { needed: number; available: number; resetsAt: string };
  /**
   * Why each `failed` happened, in the order it happened — same shape as `PublishResult.failures`.
   *
   * Every reason is also warned to the console, which is enough for the CLI operator running this
   * in their own terminal. A dashboard operator has no terminal: the board's per-row [발송] is this
   * use case, and "the send failed — check the server log" is not something they can act on.
   */
  failures: { key: string; error: string }[];
}

/** A rendering already narrowed to a channel this use-case can actually send. */
type SendableRendering = ChannelRendering & { channel: SendableChannel };

function isSendable(c: string): c is SendableChannel {
  return c === "telegram" || c === "x";
}

export class SendChannels {
  constructor(
    private readonly store: FormattingStore,
    private readonly senders: Record<SendableChannel, ChannelSender | undefined>,
    private readonly ledger: DeliveryLedger,
    /**
     * The 1차 translations every rendering descends from — `sendBlock` checks each room's approval
     * against its source's.
     *
     * Required, unlike `overrides` below, because there is no safe reading of an absent one: with no
     * source to check, a room whose translation was withdrawn — or rewritten and re-approved after
     * this copy was blessed — would send anyway, which is a live post that cannot be recalled. A new
     * call site must state where its sources come from rather than inherit a silent exemption.
     */
    private readonly translations: TranslationStore,
    private readonly record?: Recorder,
    private readonly archive?: Archiver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
    private readonly outletsFor: (channel: Channel) => Outlet[] = outletsForChannel,
    private readonly chatIds: Record<string, string> = {},
    /**
     * Per-room text overrides. Optional so every pre-outlet call site stays valid, but the CLI and
     * the dashboard both pass it: without it a forked room receives the *group* text, which is an
     * irreversible wrong post — the ledger then records the room as `sent`, and a `sent` row can
     * never be unmarked.
     */
    private readonly overrides?: OutletOverrideStore,
    /**
     * Reads how much Typefully publishing headroom is left — the same reader the board's banner
     * reads from (`publishHeadroom.ts`), so the gate and the screen can never name two different
     * numbers. Optional: a Telegram-only install has no Typefully credentials, and every pre-headroom
     * call site stays valid without it. When absent the gate does not run, which is the pre-existing
     * behaviour.
     */
    private readonly headroom?: () => Promise<Headroom>,
  ) {}

  async run(input: SendChannelsInput): Promise<SendChannelsResult> {
    const rows = await this.store.loadAll();
    const ledgered = await this.ledger.loadAll();
    const already = new Set(ledgered.map(deliveryKey));
    const wanted = new Set<SendableChannel>(input.targets);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const failures: { key: string; error: string }[] = [];

    const overrideRows = this.overrides ? await this.overrides.loadAll() : [];
    const overrideByKey = new Map(overrideRows.map((o) => [overrideKey(o), o] as const));
    const sourceByItem = new Map((await this.translations.loadAll()).map((t) => [t.itemId, t] as const));
    /** What this room actually sends: its own fork when it has one, else the group text. */
    const resolve = (r: ChannelRendering, o: Outlet): ResolvedText =>
      textFor(r, overrideByKey.get(overrideKey({ itemId: r.itemId, type: r.type, outletId: o.id })));
    const deliverable = (r: ChannelRendering, o: Outlet): boolean => {
      if (!deliveredByChannelSender(o)) return false;
      if (input.outletIds && !input.outletIds.includes(o.id)) return false;
      // Approval is per room, not per group. A forked room carries its own review: an approved
      // group must not carry an unreviewed fork out, and a `rendered` group must not hold back a
      // fork that *was* reviewed. `sendBlock` adds the upstream half — the same predicate the board
      // paints its locks from, so the screen and this loop can never disagree about a room.
      return sendBlock(resolve(r, o), sourceByItem.get(r.itemId)) === null;
    };

    const candidates = rows.filter((r): r is SendableRendering => {
      if (!isSendable(r.channel) || !wanted.has(r.channel)) return false;
      if (input.ids && !matchesItemId(input.ids, r.itemId)) return false;
      if (input.types && !input.types.includes(r.type)) return false;
      if (this.senders[r.channel] === undefined) return false;
      // No group-status gate any more: approval lives on the room. A `rendered` group can carry an
      // approved fork, and an `approved` group can carry a fork that has not been reviewed yet.
      return this.outletsFor(r.channel).some((o) => deliverable(r, o));
    });

    // Decided once for the whole batch, before anything is sent — see planRooms.
    const { blocked, unconfiguredEnv, withheld } = this.planRooms(candidates, already, ledgered, input, deliverable);

    // Before a single draft is created: can the account still publish what this batch needs?
    //
    // All-or-nothing for X, on purpose. A partial batch leaves an operator reconstructing how far
    // it got from a room-by-room ledger, and the answer changes under them as the queue publishes.
    let quotaBlocked: SendChannelsResult["quotaBlocked"];
    const xCandidates = candidates.filter((r) => r.channel === "x");
    if (this.headroom && xCandidates.length > 0) {
      // Unverified assumption, named on purpose: `needed` counts one pending room delivery as one
      // quota unit, i.e. one draft == one publish. `TypefullySender` puts a multi-segment thread
      // into a single draft's `posts[]`, so this assumes Typefully bills a whole thread as one
      // publish rather than one per tweet. Neither the docs nor the audit data confirm this, and
      // checking it live would cost real publishes against a 15/month ceiling — so this is a choice,
      // not an oversight. If it is wrong, this undercounts.
      const needed = xCandidates.reduce((n, r) => n + this.roomsFor(r, blocked, already, deliverable).pending.length, 0);
      if (needed > 0) {
        try {
          const h = await this.headroom();
          if (needed > h.available) {
            quotaBlocked = { needed, available: h.available, resetsAt: h.resetsAt };
            for (const o of this.outletsFor("x")) blocked.add(o.id);
            console.warn(`[send] X withheld: the batch needs ${needed} publish(es), ${h.available} left before ${h.resetsAt || "the next reset"}`);
          }
        } catch (err) {
          // A monitoring call must not become a new way for delivery to fail.
          console.warn(`[send] could not read the Typefully publishing quota, sending anyway: ${(err as Error).message}`);
        }
      }
    }

    for (const r of candidates) {
      const sender = this.senders[r.channel]!;

      // One delivery per room, not per channel. 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto
      // Telegram, so a channel-keyed ledger let the first room's send mark the second as done and
      // that room silently never received anything.
      // `blocked` = unconfigured, or withheld by the first-delivery guard.
      const { outlets, pending } = this.roomsFor(r, blocked, already, deliverable);
      const keyFor = (outlet: Outlet) => deliveryKey({ itemId: r.itemId, type: r.type, outletId: outlet.id });
      skipped += outlets.length - pending.length;
      if (pending.length === 0) continue;

      // Rooms that send the same text share one emit and one media parse. Unforked rooms all
      // resolve to the group copy, so the common case still does that work exactly once — but a
      // forked room now gets its own, which is the whole point of forking it.
      const byText = new Map<string, Outlet[]>();
      for (const o of pending) {
        const { text } = resolve(r, o);
        const sharing = byText.get(text);
        if (sharing) sharing.push(o);
        else byText.set(text, [o]);
      }

      for (const [text, rooms] of byText) {
        const emitResult = emit(text, DELIVERY_DESTINATION[r.channel], this.xMaxWeighted);
        if (emitResult.segments.some((s) => s.overLimit)) {
          // Sending would just 400 forever (the emitter refuses to split further) — fail fast
          // instead of hammering the API on every rerun. A human has to edit the rendering.
          // The limit is a property of the text, not of the room, so this counts once for every
          // room sharing it rather than once per room. Keyed by the rooms it cost, like every other
          // message in this loop — `…:telegram` named a channel nobody is looking at.
          const reason = `a segment exceeds the ${r.channel} limit — edit the rendering`;
          console.warn(`[send] ${r.itemId}:${r.type} skipped for ${rooms.map((o) => o.id).join(", ")}: ${reason}`);
          failures.push({ key: `${r.itemId}:${r.type}`, error: reason });
          failed += 1;
          continue;
        }

        const { photos, videos } = extractMedia(text);

        for (const outlet of rooms) {
          const key = keyFor(outlet);
          const chatId = outlet.chatIdEnv ? this.chatIds[outlet.id] : undefined;
          try {
            const segments = emitResult.segments.map((s) => s.text);
            const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments, photos, chatId });
            if (videos.length > 0) console.warn(`[send] ${key}: ${videos.length} video(s) present in the rendering, not attached this cycle`);
            const sentAt = this.now();
            // The send already happened — a ledger-write failure from here on must NOT be
            // reported as a "failed" send (that would make the next run re-send it live).
            try {
              await this.ledger.add({ itemId: r.itemId, type: r.type, outletId: outlet.id, status: "sent", at: sentAt, by: "auto", postId: res.postId, url: res.url, senderName: sender.name });
            } catch (err) {
              console.warn(`[send] ⚠ ${key} was SENT but could NOT be recorded in the ledger: ${(err as Error).message} — a rerun will re-send it; reconcile manually.`);
            }
            if (this.record) {
              try {
                await this.record({ itemId: r.itemId, type: r.type, channel: r.channel, outletId: outlet.id, postId: res.postId, url: res.url, status: "posted", publishedAt: sentAt });
              } catch (err) {
                console.warn(`[send] ${key} sent, but history record failed: ${(err as Error).message}`);
              }
            }
            if (this.archive) {
              try {
                // The archive records what the room received, so a forked room archives its fork.
                await this.archive({ itemId: r.itemId, type: r.type, channel: r.channel, outletId: outlet.id, text, postId: res.postId, url: res.url, sentAt });
              } catch (err) {
                console.warn(`[send] ${key} sent, but archive failed: ${(err as Error).message}`);
              }
            }
            sent += 1;
          } catch (err) {
            console.warn(`[send] ${key} failed: ${(err as Error).message}`);
            failures.push({ key, error: (err as Error).message });
            failed += 1;
          }
        }
      }
    }
    return { sent, skipped, failed, unconfigured: unconfiguredEnv.length, unconfiguredEnv, withheld, failures, quotaBlocked };
  }

  /**
   * The rooms this run would deliver `r` to, and which of them have not already received it.
   *
   * Extracted so the quota gate counts exactly what the send loop will send. A second copy of this
   * filter would drift, and a gate that miscounts either refuses a legal batch or lets an
   * over-quota one through — both of which are worse than the duplication it saves.
   */
  private roomsFor(
    r: SendableRendering,
    blocked: Set<string>,
    already: Set<string>,
    deliverable: (r: ChannelRendering, o: Outlet) => boolean,
  ): { outlets: Outlet[]; pending: Outlet[] } {
    const outlets = this.outletsFor(r.channel).filter((o) => deliverable(r, o) && !blocked.has(o.id));
    const pending = outlets.filter((o) => !already.has(deliveryKey({ itemId: r.itemId, type: r.type, outletId: o.id })));
    return { outlets, pending };
  }

  /**
   * Decides, before a single message goes out, which rooms this run must not deliver to.
   *
   * - **unconfigured** — the room declares a `chatIdEnv` with no value. Warned once for the room
   *   rather than once per rendering, and reported apart from `failed`: an install still on the
   *   documented legacy-only `.env` is behaving exactly as intended, and a `failed N` that grows
   *   with the backlog on every run reads as breakage.
   * - **withheld** — the room has never received anything and more than one rendering is pending
   *   for it. That is what configuring a new room after weeks of operation looks like:
   *   `renderings.json` is never pruned and `status` stays `approved`, so an unguarded run would
   *   dump the entire approved backlog into a live group at once. Naming the room in `--outlets`
   *   is the operator's confirmation and lifts the guard.
   */
  private planRooms(
    candidates: SendableRendering[],
    already: Set<string>,
    ledgered: DeliveryEntry[],
    input: SendChannelsInput,
    /** The same per-room gate the send loop applies, so the guard counts only what would go out. */
    deliverable: (r: ChannelRendering, o: Outlet) => boolean,
  ): { blocked: Set<string>; unconfiguredEnv: string[]; withheld: number } {
    const pending = new Map<string, { outlet: Outlet; count: number }>();
    for (const r of candidates) {
      for (const outlet of this.outletsFor(r.channel)) {
        if (!deliverable(r, outlet)) continue;
        if (already.has(deliveryKey({ itemId: r.itemId, type: r.type, outletId: outlet.id }))) continue;
        const seen = pending.get(outlet.id);
        if (seen) seen.count += 1;
        else pending.set(outlet.id, { outlet, count: 1 });
      }
    }

    const everDelivered = new Set(ledgered.map((e) => e.outletId));
    const blocked = new Set<string>();
    const unconfiguredEnv: string[] = [];
    let withheld = 0;

    for (const { outlet, count } of pending.values()) {
      if (outlet.chatIdEnv && !this.chatIds[outlet.id]) {
        console.warn(`[send] ${outlet.label} (${outlet.id}) not sent: ${outlet.chatIdEnv} is not set — ${count} rendering(s) waiting for it`);
        unconfiguredEnv.push(outlet.chatIdEnv);
        blocked.add(outlet.id);
        continue;
      }
      if (everDelivered.has(outlet.id) || count <= 1) continue;
      if (input.outletIds?.includes(outlet.id)) continue;
      console.warn(
        `[send] ⚠ ${outlet.label} (${outlet.id}): first delivery to this room, and ${count} approved renderings are pending — ` +
          `withheld so newly configuring a room does not post the whole backlog into it at once. ` +
          `Review them, then send deliberately: pnpm send:channels --target ${outlet.channel} --outlets ${outlet.id}`,
      );
      blocked.add(outlet.id);
      withheld += count;
    }
    return { blocked, unconfiguredEnv, withheld };
  }
}
