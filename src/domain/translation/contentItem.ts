export interface ContentItem {
  id: string; // "x:<rootId>" | "lark:<messageId>"
  source: "x" | "lark";
  text: string; // source text to translate
  createdAt: string; // ISO
  refUrl?: string;
  /**
   * X only. An Article's text is markdown running to thousands of characters, where a post is
   * plain text under 280 — reviewers need to tell them apart in one queue. Undefined for Lark.
   */
  kind?: "post" | "article";
}
