import type { FormattingStore } from "../ports/FormattingStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { ChannelSentEntry, SendableChannel, SentArchiveEntry } from "../domain/send/channels";
import { DELIVERY_DESTINATION, sentKey } from "../domain/send/channels";
import { emit } from "../domain/formatting/emitters";
import type { PublishRecord } from "../domain/sheet/models";
import { extractMedia } from "../domain/media/sourceMedia";

export interface ChannelLedger {
  loadKeys(): Promise<Set<string>>;
  add(entry: ChannelSentEntry): Promise<void>;
}
export type Recorder = (rec: PublishRecord) => Promise<void>;
export type Archiver = (entry: SentArchiveEntry) => Promise<void>;

export interface SendChannelsInput {
  targets: SendableChannel[];
  ids?: Set<string>;
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
    private readonly ledger: ChannelLedger,
    private readonly record?: Recorder,
    private readonly archive?: Archiver,
    private readonly now: () => string = () => new Date().toISOString(),
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
      if (input.ids && !input.ids.has(r.itemId)) continue;
      const sender = this.senders[r.channel];
      if (!sender) continue;
      const key = sentKey({ itemId: r.itemId, type: r.type, channel: r.channel });
      if (already.has(key)) {
        skipped += 1;
        continue;
      }
      const emitResult = emit(r.text, DELIVERY_DESTINATION[r.channel]);
      if (emitResult.segments.some((s) => s.overLimit)) {
        // Sending would just 400 forever (the emitter refuses to split further) — fail fast
        // instead of hammering the API on every rerun. A human has to edit the rendering.
        console.warn(`[send] ${key} skipped: a segment exceeds the channel limit — edit the rendering`);
        failed += 1;
        continue;
      }
      try {
        const { photos, videos } = extractMedia(r.text);
        const segments = emitResult.segments.map((s) => s.text);
        const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments, photos });
        if (videos.length > 0) console.warn(`[send] ${key}: ${videos.length} video(s) present in the rendering, not attached this cycle`);
        const sentAt = this.now();
        // The send already happened — a ledger-write failure from here on must NOT be
        // reported as a "failed" send (that would make the next run re-send it live).
        try {
          await this.ledger.add({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, senderName: sender.name, sentAt });
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
    return { sent, skipped, failed };
  }
}
