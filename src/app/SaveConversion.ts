import type { ContentVariant, ConversionType } from "../domain/conversion/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { LineageStore } from "../ports/LineageStore";

export interface SaveConversionInput {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
  convertedText: string;
}

/**
 * Stores the agent's converted copy. Always `converted` — a variant is never approved here.
 *
 * The copy an agent writes has had no human eye on it yet, so approving it at save time would both
 * skip the review and feed the unreviewed text straight into the few-shot corpus that steers every
 * later conversion (which is exactly how the corpus once ended up fighting its own style guide).
 * `ApproveRendering` marks the variant approved and promotes it, at 2차, where a human reads it.
 */
export class SaveConversion {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: SaveConversionInput): Promise<{ itemId: string; type: ConversionType }> {
    const timestamp = this.now();
    const variant: ContentVariant = {
      itemId: input.itemId,
      type: input.type,
      sourceKorean: input.sourceKorean,
      convertedText: input.convertedText,
      status: "converted",
      createdAt: timestamp,
    };
    await this.conversionStore.upsert(variant);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "converted", variant: input.type, content: input.convertedText, status: variant.status, at: timestamp });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    return { itemId: input.itemId, type: input.type };
  }
}
