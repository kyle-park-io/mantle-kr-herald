import type { LarkMessage } from "../domain/larkMessage";
import type { LarkSourceGateway } from "../ports/LarkSourceGateway";
import type { LarkRepository } from "../ports/LarkRepository";
import type { WatermarkStore } from "../shared/store/WatermarkStore";

export interface CollectLarkFailure {
  chatId: string;
  error: string;
}

export interface CollectLarkResult {
  collected: number;
  failed: CollectLarkFailure[];
}

export class CollectLarkMessages {
  constructor(
    private readonly source: LarkSourceGateway,
    private readonly repo: LarkRepository,
    private readonly watermark: WatermarkStore,
  ) {}

  async run(chatIds: string[]): Promise<CollectLarkResult> {
    let collected = 0;
    const failed: CollectLarkFailure[] = [];

    for (const chatId of chatIds) {
      try {
        const since = await this.watermark.get(chatId);

        const messages: LarkMessage[] = [];
        for await (const m of this.source.fetchMessages(chatId, since)) messages.push(m);

        if (messages.length === 0) continue;

        await this.repo.upsert(messages);
        collected += messages.length;

        const maxCreatedAt = this.maxCreatedAt(messages);
        if (maxCreatedAt && (!since || maxCreatedAt > since)) {
          await this.watermark.set(chatId, maxCreatedAt);
        }
      } catch (err) {
        failed.push({ chatId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { collected, failed };
  }

  private maxCreatedAt(messages: LarkMessage[]): string | undefined {
    let max: string | undefined;
    for (const m of messages) {
      if (!max || m.createdAt > max) max = m.createdAt;
    }
    return max;
  }
}
