import { z } from "zod";
import type { ArticleBlock, ArticleBody, MediaItem, SourceTweet, TweetMetrics, UserProfile } from "../../domain/models";
import { expandUrls } from "./expandUrls";

const MediaRaw = z
  .object({ type: z.string().optional(), media_url_https: z.string().optional() })
  .passthrough();

/** Passthrough so an unrecognised key survives collection, matching ArticleBlockRaw's rationale. */
const InlineStyleRangeRaw = z
  .object({
    offset: z.number(),
    length: z.number(),
    style: z.string(),
  })
  .passthrough();

/** One Draft.js content block. Passthrough so an unrecognised key never fails an article. */
const ArticleBlockRaw = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    inlineStyleRanges: z.array(InlineStyleRangeRaw).optional(),
    url: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

/**
 * The article summary attached to a search-result tweet. It carries a title, a ~200-character
 * excerpt and a cover image — never the body, which needs GET /twitter/article.
 */
const ArticleSummaryRaw = z
  .object({
    title: z.string(),
    preview_text: z.string().optional(),
    cover_media_img_url: z.string().optional(),
  })
  .passthrough();

/**
 * GET /twitter/article. Only `contents` is read: the rest of the payload duplicates the tweet
 * with different types (e.g. `viewCount` is a string here and a number on the tweet endpoint),
 * so nothing else is worth binding to.
 */
const ArticleResponse = z.object({
  article: z.object({ contents: z.array(z.unknown()).nullish() }).passthrough().nullish(),
});

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
    quoted_tweet: z
      .object({ url: z.string().nullable().optional(), id: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    likeCount: z.number().optional(),
    retweetCount: z.number().optional(),
    replyCount: z.number().optional(),
    quoteCount: z.number().optional(),
    viewCount: z.number().optional(),
    bookmarkCount: z.number().optional(),
    extendedEntities: z.object({ media: z.array(MediaRaw).optional() }).passthrough().optional(),
    entities: z
      .object({
        urls: z
          .array(
            z
              .object({ url: z.string().nullable().optional(), expanded_url: z.string().nullable().optional() })
              .passthrough(),
          )
          .nullish(),
      })
      .passthrough()
      .nullish(),
    article: ArticleSummaryRaw.nullish(),
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

function toArticle(raw: z.infer<typeof TweetRaw>): ArticleBody | undefined {
  if (!raw.article) return undefined;
  return {
    title: raw.article.title,
    previewText: raw.article.preview_text,
    coverImageUrl: raw.article.cover_media_img_url,
    // blocks stay undefined: the body arrives from a separate call (see CollectAuthoredContent).
  };
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

/**
 * Surface the quoted tweet's link at the end of the text (where a "↓" typically points), unless it
 * is already present — either as the URL itself or as a t.co the API expanded to the same tweet id.
 * Link only: the quoted tweet's own text is never inlined.
 */
function appendQuotedUrl(text: string, quoted?: { url?: string | null; id?: string | null } | null): string {
  const url = quoted?.url ?? undefined;
  if (!url) return text;
  if (text.includes(url)) return text;
  if (quoted?.id && text.includes(quoted.id)) return text;
  return `${text}\n${url}`;
}

/** Validate and convert a raw twitterapi.io tweet into a domain SourceTweet. */
export function normalizeTweet(raw: unknown): SourceTweet {
  const t = TweetRaw.parse(raw);
  return {
    id: t.id,
    conversationId: t.conversationId ?? t.id,
    text: appendQuotedUrl(expandUrls(t.text, t.entities?.urls ?? undefined), t.quoted_tweet),
    createdAt: new Date(t.createdAt).toISOString(),
    url: t.url,
    authorUserName: t.author?.userName ?? "",
    isReply: t.isReply ?? false,
    isQuote: t.quoted_tweet !== null && t.quoted_tweet !== undefined,
    media: toMedia(t),
    article: toArticle(t),
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

/**
 * Validate a GET /twitter/article payload and return its content blocks. A block that fails
 * validation is skipped with a warning rather than rejecting the article, mirroring how
 * `TwitterApiSourceGateway.normalizeOrSkip` treats a malformed tweet.
 */
export function parseArticleContents(data: unknown): ArticleBlock[] {
  const parsed = ArticleResponse.parse(data);
  const blocks: ArticleBlock[] = [];
  for (const raw of parsed.article?.contents ?? []) {
    const result = ArticleBlockRaw.safeParse(raw);
    if (!result.success) {
      console.warn(`[twitterapi] skipping malformed article block: ${result.error.message}`);
      continue;
    }
    // Push the validated object itself, not a destructured re-literal: destructuring only the six
    // keys named here silently discards any other key the API sends (notably `entityRanges`, the
    // one thing the design spec's "Known limitations" says the mapping cannot yet handle — but
    // only if it survives into storage for a later remapping to use). `.passthrough()` on
    // ArticleBlockRaw keeps unknown keys on `result.data`; ArticleBlock has no index signature, so
    // this relies on structural typing rather than triggering excess-property checks (which only
    // apply to fresh object literals).
    blocks.push(result.data);
  }
  return blocks;
}

const UserProfileData = z
  .object({ userName: z.string().optional(), statusesCount: z.number().optional(), followers: z.number().optional() })
  .passthrough();
const UserInfoResponse = z.object({ data: UserProfileData });

/** Validate a GET /twitter/user/info payload. Never throws: a malformed response degrades to
 *  { userName: fallbackUserName, statusesCount: undefined, followers: undefined } so `tm:measure`
 *  can still report. */
export function parseUserProfile(data: unknown, fallbackUserName: string): UserProfile {
  const r = UserInfoResponse.safeParse(data);
  const d = r.success ? r.data.data : {};
  return {
    userName: d.userName ?? fallbackUserName,
    statusesCount: typeof d.statusesCount === "number" ? d.statusesCount : undefined,
    followers: typeof d.followers === "number" ? d.followers : undefined,
  };
}
