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
