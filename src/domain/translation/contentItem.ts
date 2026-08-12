export interface ContentItem {
  id: string; // "x:<rootId>" | "lark:<messageId>"
  source: "x" | "lark";
  text: string; // source text to translate
  createdAt: string; // ISO
  refUrl?: string;
  /** X only. The root tweet's `isReply` — a reply is optional content a reviewer may skip. Undefined for Lark. */
  isReply?: boolean;
  /**
   * X only. An Article's text is markdown running to thousands of characters, where a post is
   * plain text under 280 — reviewers need to tell them apart in one queue. Undefined for Lark.
   */
  kind?: "post" | "article";
  /**
   * X only. The root tweet's `authorUserName`. Undefined for Lark, which has no X handle, and for a
   * thread stored with no tweets at all.
   *
   * Not shown to anyone: it is read by `meetsTranslateFloor` (`./translateFloor.ts`) to decide
   * whether the translate floor applies to this item — it applies to the account the scheduled sweep
   * reads (`src/domain/sweptAccount.ts`) and not to a post a person hand-picked from another
   * account. All four places that apply the floor ask through that one function: the tick that
   * selects (`PrepareTranslations.applySelector`), the 링크 수집 waiting list
   * (`createDeps.loadIntakePending`), the Collected count `pnpm status` and the dashboard's
   * 수집 card are drawn from (`collectedScope`, `src/status/translateFloor.ts`), and the 링크 수집
   * door (`CollectLinkedThread`), which asks about a root tweet before any item exists for it.
   *
   * Undefined therefore means "assume the floor applies", which is the conservative direction: see
   * `meetsTranslateFloor` for why the unreadable case must stay shut.
   */
  author?: string;
}
