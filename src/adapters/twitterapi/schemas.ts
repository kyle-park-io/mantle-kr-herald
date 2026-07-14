import { z } from "zod";
import type { MediaItem, SourceTweet, TweetMetrics } from "../../domain/models";

const MediaRaw = z
  .object({ type: z.string().optional(), media_url_https: z.string().optional() })
  .passthrough();

const TweetRaw = z
  .object({
    id: z.string(),
    url: z.string(),
    text: z.string(),
    createdAt: z.string(),
    conversationId: z.string().optional(),
    isReply: z.boolean().optional(),
    // Live data sometimes omits the author (or its userName) on peripheral tweets
    // (e.g. gap-filled thread roots from deleted/suspended accounts). Tolerate it
    // rather than aborting the whole collect.
    author: z.object({ userName: z.string().optional() }).passthrough().optional(),
    quoted_tweet: z.unknown().nullable().optional(),
    likeCount: z.number().optional(),
    retweetCount: z.number().optional(),
    replyCount: z.number().optional(),
    quoteCount: z.number().optional(),
    viewCount: z.number().optional(),
    bookmarkCount: z.number().optional(),
    extendedEntities: z.object({ media: z.array(MediaRaw).optional() }).passthrough().optional(),
  })
  .passthrough();

const TweetListResponse = z.object({
  // The live API returns null (not just absent) for these on the last page,
  // so accept string | null | undefined and normalize in parseTweetList.
  tweets: z.array(z.unknown()).nullish(),
  has_next_page: z.boolean().nullish(),
  next_cursor: z.string().nullish(),
});

function toMedia(raw: z.infer<typeof TweetRaw>): MediaItem[] | undefined {
  const media = raw.extendedEntities?.media;
  if (!media || media.length === 0) return undefined;
  const items: MediaItem[] = [];
  for (const m of media) {
    if (!m.media_url_https) continue;
    const type = m.type === "video" || m.type === "animated_gif" ? m.type : "photo";
    items.push({ type, url: m.media_url_https });
  }
  return items.length ? items : undefined;
}

function toMetrics(raw: z.infer<typeof TweetRaw>): TweetMetrics | undefined {
  const metrics: TweetMetrics = {
    likeCount: raw.likeCount,
    retweetCount: raw.retweetCount,
    replyCount: raw.replyCount,
    quoteCount: raw.quoteCount,
    viewCount: raw.viewCount,
    bookmarkCount: raw.bookmarkCount,
  };
  return Object.values(metrics).some((v) => v !== undefined) ? metrics : undefined;
}

/** Validate and convert a raw twitterapi.io tweet into a domain SourceTweet. */
export function normalizeTweet(raw: unknown): SourceTweet {
  const t = TweetRaw.parse(raw);
  return {
    id: t.id,
    conversationId: t.conversationId ?? t.id,
    text: t.text,
    createdAt: new Date(t.createdAt).toISOString(),
    url: t.url,
    authorUserName: t.author?.userName ?? "",
    isReply: t.isReply ?? false,
    isQuote: t.quoted_tweet !== null && t.quoted_tweet !== undefined,
    media: toMedia(t),
    metrics: toMetrics(t),
  };
}

/** Validate a list-shaped response ({tweets, has_next_page, next_cursor}). */
export function parseTweetList(data: unknown): {
  tweets: unknown[];
  hasNextPage: boolean;
  nextCursor: string;
} {
  const parsed = TweetListResponse.parse(data);
  return {
    tweets: parsed.tweets ?? [],
    hasNextPage: parsed.has_next_page ?? false,
    nextCursor: parsed.next_cursor ?? "",
  };
}
