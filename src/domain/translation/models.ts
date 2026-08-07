export type GlossaryRule = "translate" | "transliterate" | "keep";

export interface GlossaryEntry {
  term: string;
  rule: GlossaryRule;
  target?: string;
  note?: string;
  updatedAt: string;
  source?: string;
}

export interface StyleGuide {
  text: string;
}

export interface Locale {
  dateFormat: string;
  numberFormat: string;
  currency: string;
  unit: string;
  honorific: string;
}

export interface FewShotExample {
  source: string;
  target: string;
  itemId?: string;
}

/**
 * `posted` marks a translation a human already published by hand on X, discovered by reconcile
 * matching it against a live thread — never `published`, which already means "uploaded to Drive"
 * elsewhere in this repo.
 *
 * The array is the source of truth, same shape as `ALL_DELIVERY_STATUSES` in
 * `src/domain/delivery/models.ts`: `TranslationStatus` is *derived* from `ALL_TRANSLATION_STATUSES`
 * rather than declared separately and checked against it, because a separately-declared union plus
 * a `satisfies`-checked literal both erase at runtime — `vitest` transpiles through esbuild, which
 * strips `satisfies` without evaluating it, so a test iterating such a list would silently keep
 * iterating the old members forever. Deriving the type from the array instead means there is only
 * one place to edit.
 */
export const ALL_TRANSLATION_STATUSES = ["translated", "approved", "posted"] as const;
export type TranslationStatus = (typeof ALL_TRANSLATION_STATUSES)[number];

export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: TranslationStatus;
  translatedAt: string;
  approvedAt?: string;
  isReply?: boolean;
  refUrl?: string;
  /** The live X post a reconcile match found this translation already published as, by hand. */
  postedUrl?: string;
  /**
   * When the live post in `postedUrl` was created — the root tweet's own `createdAt`, read off the
   * account, so it IS when the human actually posted it. Not a reconcile timestamp: nothing in this
   * path reads a clock, and `RetireTranslation` writes this value straight into the publish-history
   * row's `publishedAt`, which is what `impressions:record` measures against.
   *
   * (This comment used to claim the opposite — "when reconcile recorded the match, not when the
   * human actually posted it" — which described neither where the value comes from nor where it
   * goes. Corrected by the final branch review.)
   */
  postedAt?: string;
}

export interface SharedContext {
  role: string;
  glossary: GlossaryEntry[];
  styleGuide: StyleGuide;
  locale: Locale;
  fewShots: FewShotExample[];
}
