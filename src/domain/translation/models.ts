export type GlossaryRule = "translate" | "transliterate" | "keep";

export interface GlossaryEntry {
  term: string;
  rule: GlossaryRule;
  target?: string;
  note?: string;
  updatedAt: string;
  source?: string;
}

/**
 * A glossary candidate a human has looked at and said no to — `translation/glossary-dismissed.json`.
 *
 * Steering config, not state, and it is what keeps `glossary:mine` worth reading. That command has no
 * cursor and no "seen" memory: it re-derives every candidate from the whole ledger each week, so a
 * term nobody wants in the glossary arrives again next Monday, and the Monday after that, until the
 * alert is noise people scroll past — the exact failure `translate:check --notify` was designed
 * around when it refused to page on drift (see `overrideNotification`, src/cli/translateCheckReport.ts).
 * Recording the "no" is the only thing that makes a repeated report converge.
 */
export interface GlossaryDismissal {
  /**
   * The candidate's key exactly as `glossary:mine` prints it: a term (`Turing Test`) for a proper
   * noun, or `초안 → 발행` (`규모 → 사이즈`) for a substitution. Matched case-insensitively with
   * whitespace collapsed, so a copy-paste that picks up a double space still silences the candidate.
   */
  term: string;
  /** Why. Nothing reads it — it is for whoever wonders, a year later, why this never shows up. */
  note?: string;
  /** `YYYY-MM-DD`. Same hand-written shape as `GlossaryEntry.updatedAt`. */
  dismissedAt?: string;
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
  /**
   * Punctuation the Korean copy may and may not use. Optional because `readJsonFile` replaces
   * `DEFAULT_LOCALE` wholesale instead of merging into it (see `shared/store/jsonFile.ts`), so
   * every `locale.json` and stored locale written before this field existed parses without it —
   * `renderLocale` drops the line rather than printing `undefined` as a rule.
   */
  punctuation?: string;
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
  /** The live post's body, as read off the account after a reconcile match — nothing normalises it. */
  publishedText?: string;
}

export interface SharedContext {
  role: string;
  glossary: GlossaryEntry[];
  styleGuide: StyleGuide;
  locale: Locale;
  fewShots: FewShotExample[];
}
