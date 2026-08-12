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
   * Not shown to anyone: it is read by `PrepareTranslations.applySelector` to decide whether the
   * translate floor applies to this item — it applies to the account the scheduled sweep reads
   * (`src/domain/sweptAccount.ts`) and not to a post a person hand-picked from another account.
   * Undefined therefore means "assume the floor applies", which is the conservative direction: see
   * `applySelector` for why the unreadable case must stay shut.
   */
  author?: string;
}
