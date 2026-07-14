import type { LarkMessage } from "../domain/larkMessage";
import type { LarkSourceGateway } from "../ports/LarkSourceGateway";
import type { LarkRepository } from "../ports/LarkRepository";
import type { WatermarkStore } from "../shared/store/WatermarkStore";

export interface CollectLarkResult {
  collected: number;
  failed: string[];
}

export class CollectLarkMessages {
  constructor(
    private readonly source: LarkSourceGateway,
    private readonly repo: LarkRepository,
    private readonly watermark: WatermarkStore,
  ) {}

  async run(chatIds: string[]): Promise<CollectLarkResult> {
    let collected = 0;
    const failed: string[] = [];

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
      } catch {
        failed.push(chatId);
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
