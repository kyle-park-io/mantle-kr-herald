import type { ConversionType } from "../domain/conversion/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";

export interface SaveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
}

export class SaveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveRenderingInput): Promise<{ itemId: string; type: ConversionType; channel: Channel }> {
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, createdAt: this.now(),
    };
    await this.formattingStore.upsert(rendering);
    return { itemId: input.itemId, type: input.type, channel: input.channel };
  }
}
