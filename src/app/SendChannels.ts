import type { FormattingStore } from "../ports/FormattingStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { ChannelSentEntry, SendableChannel } from "../domain/send/channels";
import { DELIVERY_DESTINATION, sentKey } from "../domain/send/channels";
import { emit } from "../domain/formatting/emitters";
import type { PublishRecord } from "../domain/sheet/models";

export interface ChannelLedger {
  loadKeys(): Promise<Set<string>>;
  add(entry: ChannelSentEntry): Promise<void>;
}
export type Recorder = (rec: PublishRecord) => Promise<void>;

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
      try {
        const segments = emit(r.text, DELIVERY_DESTINATION[r.channel]).segments.map((s) => s.text);
        const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments });
        const sentAt = this.now();
        await this.ledger.add({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, senderName: sender.name, sentAt });
        if (this.record) {
          try {
            await this.record({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, status: "posted", publishedAt: sentAt });
          } catch (err) {
            console.warn(`[send] ${key} sent, but history record failed: ${(err as Error).message}`);
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
