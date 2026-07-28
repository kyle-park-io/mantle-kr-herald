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
import { emit } from "../domain/formatting/emitters";
import { matchesItemId } from "../domain/itemId";
import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";
import type { PublishRecord } from "../domain/sheet/models";
import { extractMedia } from "../domain/media/sourceMedia";

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
    private readonly record?: Recorder,
    private readonly archive?: Archiver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
    private readonly outletsFor: (channel: Channel) => Outlet[] = outletsForChannel,
    private readonly chatIds: Record<string, string> = {},
  ) {}

  async run(input: SendChannelsInput): Promise<SendChannelsResult> {
    const rows = await this.store.loadAll();
    const ledgered = await this.ledger.loadAll();
    const already = new Set(ledgered.map(deliveryKey));
    const wanted = new Set<SendableChannel>(input.targets);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    const candidates = rows.filter((r): r is SendableRendering => {
      if (r.status !== "approved") return false;
      if (!isSendable(r.channel) || !wanted.has(r.channel)) return false;
      if (input.ids && !matchesItemId(input.ids, r.itemId)) return false;
      if (input.types && !input.types.includes(r.type)) return false;
      return this.senders[r.channel] !== undefined;
    });

    // Decided once for the whole batch, before anything is sent — see planRooms.
    const { blocked, unconfiguredEnv, withheld } = this.planRooms(candidates, already, ledgered, input);

    for (const r of candidates) {
      const sender = this.senders[r.channel]!;

      // One delivery per room, not per channel. 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto
      // Telegram, so a channel-keyed ledger let the first room's send mark the second as done and
      // that room silently never received anything.
      const outlets = this.outletsFor(r.channel).filter((o) => {
        if (!deliveredByChannelSender(o)) return false;
        if (input.outletIds && !input.outletIds.includes(o.id)) return false;
        if (blocked.has(o.id)) return false; // unconfigured, or withheld by the first-delivery guard
        return true;
      });
      const keyFor = (outlet: Outlet) => deliveryKey({ itemId: r.itemId, type: r.type, outletId: outlet.id });
      const pending = outlets.filter((o) => !already.has(keyFor(o)));
      skipped += outlets.length - pending.length;
      if (pending.length === 0) continue;

      const emitResult = emit(r.text, DELIVERY_DESTINATION[r.channel], this.xMaxWeighted);
      if (emitResult.segments.some((s) => s.overLimit)) {
        // Sending would just 400 forever (the emitter refuses to split further) — fail fast
        // instead of hammering the API on every rerun. A human has to edit the rendering.
        // The limit is a property of the rendering, not of the room, so this counts once for all
        // of them rather than once per room. Keyed by the rooms it cost, like every other message
        // in this loop — `…:telegram` named a channel nobody is looking at.
        console.warn(`[send] ${r.itemId}:${r.type} skipped for ${pending.map((o) => o.id).join(", ")}: a segment exceeds the channel limit — edit the rendering`);
        failed += 1;
        continue;
      }

      // Hoisted: the media is a property of the rendering, not of the room, so parsing it once per
      // room re-did identical work for every outlet on the channel.
      const { photos, videos } = extractMedia(r.text);

      for (const outlet of pending) {
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
              await this.archive({ itemId: r.itemId, type: r.type, channel: r.channel, outletId: outlet.id, text: r.text, postId: res.postId, url: res.url, sentAt });
            } catch (err) {
              console.warn(`[send] ${key} sent, but archive failed: ${(err as Error).message}`);
            }
          }
          sent += 1;
        } catch (err) {
          console.warn(`[send] ${key} failed: ${(err as Error).message}`);
          failed += 1;
        }
      }
    }
    return { sent, skipped, failed, unconfigured: unconfiguredEnv.length, unconfiguredEnv, withheld };
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
  ): { blocked: Set<string>; unconfiguredEnv: string[]; withheld: number } {
    const pending = new Map<string, { outlet: Outlet; count: number }>();
    for (const r of candidates) {
      for (const outlet of this.outletsFor(r.channel)) {
        if (!deliveredByChannelSender(outlet)) continue;
        if (input.outletIds && !input.outletIds.includes(outlet.id)) continue;
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
