export type CollectionStatus = "active" | "deleted";

export interface MediaItem {
  type: "photo" | "video" | "animated_gif";
  url: string;
}

export interface TweetMetrics {
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  viewCount?: number;
  bookmarkCount?: number;
}

/** One styled span inside an article block. Offsets are UTF-16 code units, matching JS strings. */
export interface InlineStyleRange {
  offset: number;
  length: number;
  style: string; // observed: "Bold", "Italic"
}

/**
 * One Draft.js content block from an X Article body. `type` is deliberately a plain string
 * rather than a union: the seven observed values are a closed set today, but a value we have
 * never seen must render as a paragraph rather than fail validation.
 */
export interface ArticleBlock {
  type: string; // observed: unstyled | header-one | header-two | ordered-list-item | unordered-list-item | divider | image
  text?: string;
  inlineStyleRanges?: InlineStyleRange[];
  url?: string; // image blocks only
  width?: number;
  height?: number;
}

/**
 * An X Article riding on a tweet. The search response carries only `title`/`previewText`/
 * `coverImageUrl`; `blocks` is filled by a second call (see CollectAuthoredContent), so it is
 * undefined between collection steps and stays undefined if that call fails.
 */
export interface ArticleBody {
  title: string;
  previewText?: string; // ~200-character excerpt from the search response, not the body
  coverImageUrl?: string;
  blocks?: ArticleBlock[];
}

export interface SourceTweet {
  id: string;
  conversationId: string; // thread key; the root tweet's id
  text: string;
  createdAt: string; // ISO 8601 UTC
  url: string;
  authorUserName: string;
  isReply: boolean;
  isQuote: boolean; // quoted_tweet present in the raw payload
  media?: MediaItem[];
  article?: ArticleBody; // present only when this tweet is an X Article
  metrics?: TweetMetrics;
}

export interface AssembledThread {
  rootId: string;
  tweets: SourceTweet[]; // chronological
}

export interface CollectedThread {
  rootId: string;
  tweets: SourceTweet[];
  status: CollectionStatus;
  firstSeenAt: string; // when we first stored it (ISO)
  deletedAt?: string; // set only when status === "deleted"
}
