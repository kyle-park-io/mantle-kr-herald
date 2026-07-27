import type { ContentVariant, ConversionType } from "../domain/conversion/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { LineageStore } from "../ports/LineageStore";

export interface SaveConversionInput {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
  convertedText: string;
  approve: boolean;
}

export class SaveConversion {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly fewShotByType: Record<ConversionType, FewShotStore>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: SaveConversionInput): Promise<{ itemId: string; type: ConversionType; promoted: boolean }> {
    const timestamp = this.now();
    const variant: ContentVariant = {
      itemId: input.itemId,
      type: input.type,
      sourceKorean: input.sourceKorean,
      convertedText: input.convertedText,
      status: input.approve ? "approved" : "converted",
      createdAt: timestamp,
      approvedAt: input.approve ? timestamp : undefined,
    };
    await this.conversionStore.upsert(variant);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "converted", variant: input.type, content: input.convertedText, status: variant.status, at: timestamp });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    if (input.approve) {
      await this.fewShotByType[input.type].add({ source: input.sourceKorean, target: input.convertedText, itemId: input.itemId });
    }
    return { itemId: input.itemId, type: input.type, promoted: input.approve };
  }
}
