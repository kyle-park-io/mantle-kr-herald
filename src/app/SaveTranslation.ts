import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";

export interface SaveInput {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  approve: boolean;
}

export class SaveTranslation {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly fewShotStore: FewShotStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveInput): Promise<{ itemId: string; promoted: boolean }> {
    const timestamp = this.now();
    const translation: Translation = {
      itemId: input.itemId,
      source: input.source,
      sourceText: input.sourceText,
      koreanText: input.koreanText,
      status: input.approve ? "approved" : "translated",
      translatedAt: timestamp,
      approvedAt: input.approve ? timestamp : undefined,
    };
    await this.translationStore.upsert(translation);

    if (input.approve) {
      await this.fewShotStore.add({ source: input.sourceText, target: input.koreanText, itemId: input.itemId });
    }
    return { itemId: input.itemId, promoted: input.approve };
  }
}
