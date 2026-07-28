import type { FormattingStore } from "../ports/FormattingStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { SendableChannel, SentArchiveEntry } from "../domain/send/channels";
import { DELIVERY_DESTINATION } from "../domain/send/channels";
import { deliveryKey } from "../domain/delivery/models";
import type { Channel } from "../domain/formatting/models";
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
  /** Restrict delivery to these outlet ids (`--outlets`). Absent = every auto room on the channel. */
  outletIds?: string[];
}
export interface SendChannelsResult {
  sent: number;
  skipped: number;
  failed: number;
}

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
    const already = await this.ledger.loadKeys();
    const wanted = new Set<SendableChannel>(input.targets);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows) {
      if (r.status !== "approved") continue;
      if (!isSendable(r.channel) || !wanted.has(r.channel)) continue;
      if (input.ids && !matchesItemId(input.ids, r.itemId)) continue;
      const sender = this.senders[r.channel];
      if (!sender) continue;

      // One delivery per room, not per channel. 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto
      // Telegram, so a channel-keyed ledger let the first room's send mark the second as done and
      // that room silently never received anything.
      const outlets = this.outletsFor(r.channel).filter((o) => {
        if (!deliveredByChannelSender(o)) return false;
        if (input.outletIds && !input.outletIds.includes(o.id)) return false;
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
        // of them rather than once per room.
        console.warn(`[send] ${r.itemId}:${r.type}:${r.channel} skipped: a segment exceeds the channel limit — edit the rendering`);
        failed += 1;
        continue;
      }

      for (const outlet of pending) {
        const key = keyFor(outlet);
        const chatId = outlet.chatIdEnv ? this.chatIds[outlet.id] : undefined;
        if (outlet.chatIdEnv && !chatId) {
          console.warn(`[send] ${key} skipped: ${outlet.chatIdEnv} is not set`);
          continue;
        }
        try {
          const { photos, videos } = extractMedia(r.text);
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
              await this.record({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, status: "posted", publishedAt: sentAt });
            } catch (err) {
              console.warn(`[send] ${key} sent, but history record failed: ${(err as Error).message}`);
            }
          }
          if (this.archive) {
            try {
              await this.archive({ itemId: r.itemId, type: r.type, channel: r.channel, text: r.text, postId: res.postId, url: res.url, sentAt });
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
    return { sent, skipped, failed };
  }
}
