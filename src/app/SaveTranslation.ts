import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { LineageStore } from "../ports/LineageStore";

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
  isReply?: boolean;
  refUrl?: string;
}

export class SaveTranslation {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly fewShotStore: FewShotStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: SaveInput): Promise<{ itemId: string; promoted: boolean }> {
    const timestamp = this.now();
    // `upsert` writes a whole row (see PgTranslationStore), so a save that just constructs a fresh
    // Translation would silently drop postedUrl/postedAt/publishedText on any edit to an item
    // reconcile already retired. Reading the existing row first — rather than adding a second,
    // narrower write path — keeps `upsert` the only place a Translation ever reaches the store, so
    // nothing can race it.
    const existing = (await this.translationStore.loadAll()).find((t) => t.itemId === input.itemId);
    const translation: Translation = {
      itemId: input.itemId,
      source: input.source,
      sourceText: input.sourceText,
      koreanText: input.koreanText,
      status: input.approve ? "approved" : "translated",
      translatedAt: timestamp,
      approvedAt: input.approve ? timestamp : undefined,
      isReply: input.isReply,
      refUrl: input.refUrl,
      postedUrl: existing?.postedUrl,
      postedAt: existing?.postedAt,
      publishedText: existing?.publishedText,
    };
    await this.translationStore.upsert(translation);

    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "translated", content: input.koreanText, status: translation.status, sourceText: input.sourceText, at: timestamp });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }

    // Approval and saving always succeed regardless of size — only promotion into the few-shot
    // corpus is gated, so an oversized source (an X Article) does not dominate every future prompt.
    const promote = input.approve && input.sourceText.length <= MAX_FEW_SHOT_SOURCE_LENGTH;
    if (promote) {
      await this.fewShotStore.add({ source: input.sourceText, target: input.koreanText, itemId: input.itemId });
    }
    return { itemId: input.itemId, promoted: promote };
  }
}
