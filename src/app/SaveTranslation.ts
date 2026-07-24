import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";

/**
 * A promoted few-shot example is inlined into every subsequent worksheet (the last `MAX_FEW_SHOTS`
 * — see `PrepareTranslations` — are re-sent on every batch), so its cost is paid many times over,
 * not once. `translation/few-shot.json`'s corpus today is 10 entries averaging ~415 characters
 * (source + target combined); the largest single entry is an 831-character source (a 3-tweet
 * thread). An approved X Article's `sourceText` can run 3,774–12,215 characters (see
 * `docs/superpowers/specs/2026-07-23-x-article-support-design.md`) — several times the *entire*
 * corpus in one example, and its own `#`/`##` heading lines would nest inside the worksheet's own
 * markdown sections. 2000 sits comfortably above any real tweet thread observed so far and well
 * below the smallest observed article body, so it separates the two without a close call.
 */
const MAX_FEW_SHOT_SOURCE_LENGTH = 2000;

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

    // Approval and saving always succeed regardless of size — only promotion into the few-shot
    // corpus is gated, so an oversized source (an X Article) does not dominate every future prompt.
    const promote = input.approve && input.sourceText.length <= MAX_FEW_SHOT_SOURCE_LENGTH;
    if (promote) {
      await this.fewShotStore.add({ source: input.sourceText, target: input.koreanText, itemId: input.itemId });
    }
    return { itemId: input.itemId, promoted: promote };
  }
}
