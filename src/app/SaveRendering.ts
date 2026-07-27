import type { ConversionType } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";
import type { LineageStore } from "../ports/LineageStore";

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
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: SaveRenderingInput): Promise<{ itemId: string; type: ConversionType; channel: Channel }> {
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: toCanonical(input.text), refined: true, createdAt: this.now(), status: "rendered",
    };
    await this.formattingStore.upsert(rendering);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "rendered", variant: `${input.type}/${input.channel}`, content: rendering.text, status: rendering.status, at: rendering.createdAt });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    return { itemId: input.itemId, type: input.type, channel: input.channel };
  }
}
