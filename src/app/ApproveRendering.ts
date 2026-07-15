import type { ConversionType } from "../domain/conversion/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";

export interface ApproveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class ApproveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: ApproveRenderingInput): Promise<ChannelRendering | undefined> {
    const all = await this.formattingStore.loadAll();
    const existing = all.find((r) => r.itemId === input.itemId && r.type === input.type && r.channel === input.channel);
    if (!existing) return undefined;
    const approved: ChannelRendering = { ...existing, status: "approved", approvedAt: this.now() };
    await this.formattingStore.upsert(approved);
    return approved;
  }
}
