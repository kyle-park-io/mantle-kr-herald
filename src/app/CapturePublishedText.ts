import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";

/** What `CapturePublishedText.run` was given: one row of `reconcileXPublished`'s `plan.captures`. */
export interface CaptureInput {
  itemId: string;
  text: string;
}

/**
 * Writes one `PublishedTextCapture` (`src/domain/publish/publishedTextCapture.ts`) into the
 * `Translation` row's `publishedText` cell — the write half of `plan.captures`, the same relationship
 * `RetireTranslation` has to `plan.posted`.
 *
 * Fill-only, never overwrite: `publishedText` is set once and never touched again by this class.
 * `capturePublishedTexts` already skips any translation whose `publishedText` is a non-empty string
 * when it builds the plan, but the store can have moved on since the plan was built — a concurrent
 * run, or a human's own edit — so this class re-checks the row it just read rather than trusting the
 * plan blindly, and reports `"already-present"` **without calling `upsert`** when it finds a value
 * already there. Not "upsert with the same text" — no write at all, so a value someone else just
 * wrote is never raced against.
 */
export class CapturePublishedText {
  constructor(private readonly translationStore: TranslationStore) {}

  async run(input: CaptureInput): Promise<"captured" | "already-present"> {
    const { itemId, text } = input;

    const all = await this.translationStore.loadAll();
    const existing = all.find((t) => t.itemId === itemId);
    if (existing === undefined) {
      // capturePublishedTexts built plan.captures from the same translations list this itemId came
      // from, so this should be unreachable outside a caller passing a stale plan against a store
      // whose row vanished in between — worth failing loudly on rather than silently writing a
      // fresh row with none of the translation's own history. Same reasoning and wording as
      // RetireTranslation's own missing-row error.
      throw new Error(`CapturePublishedText: no translation row for ${itemId} — cannot capture what does not exist`);
    }

    if (existing.publishedText !== undefined && existing.publishedText !== "") {
      return "already-present";
    }

    // Spread `existing`, not a fresh object: only publishedText is this class's to set. Every other
    // field (sourceText, koreanText, status, postedUrl, postedAt, approvedAt, isReply, refUrl, ...)
    // is preserved from the row this class just read — the same "only touch the columns you own"
    // discipline RetireTranslation.run keeps for status/postedUrl/postedAt.
    const updated: Translation = { ...existing, publishedText: text };
    await this.translationStore.upsert(updated);
    return "captured";
  }
}
