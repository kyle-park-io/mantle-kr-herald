import { describe, it, expect } from "vitest";
import { normalizeTweet, parseArticle, parseTweetList } from "../../src/adapters/twitterapi/schemas";

const rawTweet = {
  id: "2071473308198158423",
  url: "https://x.com/Mantle_Official/status/2071473308198158423",
  text: "Mantle update",
  createdAt: "Mon Jun 29 05:58:17 +0000 2026",
  conversationId: "2071473308198158423",
  isReply: false,
  author: { userName: "Mantle_Official", name: "Mantle" },
  quoted_tweet: { id: "999", url: "https://x.com/x/status/999" },
  likeCount: 2,
  viewCount: 156,
  extendedEntities: {
    media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/x.jpg" }],
  },
};

describe("normalizeTweet", () => {
  it("maps a raw twitterapi.io tweet to SourceTweet with ISO createdAt", () => {
    const t = normalizeTweet(rawTweet);
    expect(t.id).toBe("2071473308198158423");
    expect(t.conversationId).toBe("2071473308198158423");
    expect(t.authorUserName).toBe("Mantle_Official");
    expect(t.createdAt).toBe("2026-06-29T05:58:17.000Z");
    expect(t.isQuote).toBe(true);
    expect(t.metrics?.likeCount).toBe(2);
    expect(t.media).toEqual([{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]);
  });

  it("defaults conversationId to id and isQuote to false when absent", () => {
    const t = normalizeTweet({
      id: "5",
      url: "u",
      text: "hi",
      createdAt: "Mon Jun 29 05:58:17 +0000 2026",
      author: { userName: "Mantle_Official" },
    });
    expect(t.conversationId).toBe("5");
    expect(t.isQuote).toBe(false);
    expect(t.isReply).toBe(false);
  });

  it("throws when a required field is missing", () => {
    expect(() => normalizeTweet({ url: "u", text: "t" })).toThrow();
  });

  it("normalizeTweet defaults media type to photo when a media entry omits type", () => {
    const t = normalizeTweet({
      id: "5",
      url: "u",
      text: "hi",
      createdAt: "Mon Jun 29 05:58:17 +0000 2026",
      author: { userName: "Mantle_Official" },
      extendedEntities: {
        media: [{ media_url_https: "https://x/y.jpg" }],
      },
    });
    expect(t.media).toEqual([{ type: "photo", url: "https://x/y.jpg" }]);
  });

  it("tolerates a missing author or userName (authorUserName defaults to '')", () => {
    const base = { id: "9", url: "u", text: "hi", createdAt: "Mon Jun 29 05:58:17 +0000 2026" };
    expect(normalizeTweet({ ...base, author: {} }).authorUserName).toBe("");
    expect(normalizeTweet(base).authorUserName).toBe("");
  });

  it("expands t.co links via entities.urls and strips media t.co, keeping media on SourceTweet", () => {
    const t = normalizeTweet({
      id: "1",
      url: "u",
      createdAt: "Mon Jun 29 05:58:17 +0000 2026",
      author: { userName: "Mantle_Official" },
      text: "Trade here: https://t.co/real\n\nclip https://t.co/media",
      entities: { urls: [{ url: "https://t.co/real", expanded_url: "http://fluxion.network/trade" }] },
      extendedEntities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/v.mp4" }] },
    });
    expect(t.text).toBe("Trade here: http://fluxion.network/trade\n\nclip");
    expect(t.text).not.toContain("t.co");
    expect(t.media).toEqual([{ type: "video", url: "https://pbs.twimg.com/v.mp4" }]);
  });

  it("tolerates a null-shaped entities.urls (live API sends null, not just absent) without throwing", () => {
    const t = normalizeTweet({
      id: "1",
      url: "u",
      createdAt: "Mon Jun 29 05:58:17 +0000 2026",
      author: { userName: "Mantle_Official" },
      text: "hi https://t.co/media",
      entities: { urls: null },
    });
    expect(t.text).toBe("hi");
  });
});

/**
 * The mp4 lives in `extendedEntities.media[].video_info.variants`, alongside an HLS playlist and
 * several bitrate ladders; `media_url_https` on the same entry is the *thumbnail*. These fixtures
 * are trimmed from the real payload of tweet 2076703861872660873 (verified live 2026-08-08:
 * the mp4 urls answer 200 `video/mp4` with `access-control-allow-origin: *`, no auth, no referer).
 */
const VIDEO_THUMB = "https://pbs.twimg.com/amplify_video_thumb/2076703853182074880/img/QcSbOAZluJllwyue.jpg";
const MP4_320 = "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/320x320/lo.mp4?tag=14";
const MP4_540 = "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/540x540/mid.mp4?tag=14";
const MP4_720 = "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/720x720/hi.mp4?tag=14";
const HLS = "https://video.twimg.com/amplify_video/2076703853182074880/pl/playlist.m3u8";

const videoTweet = (mediaOverride: Record<string, unknown>) => ({
  id: "2076703861872660873",
  url: "https://x.com/Mantle_Official/status/2076703861872660873",
  text: "clip",
  createdAt: "Mon Jun 29 05:58:17 +0000 2026",
  author: { userName: "Mantle_Official" },
  extendedEntities: { media: [{ type: "video", media_url_https: VIDEO_THUMB, ...mediaOverride }] },
});

describe("normalizeTweet video capture", () => {
  it("keeps the highest-bitrate mp4 as videoUrl and the thumbnail as url", () => {
    const t = normalizeTweet(
      videoTweet({
        video_info: {
          aspect_ratio: [1, 1],
          duration_millis: 5038,
          variants: [
            { content_type: "application/x-mpegURL", url: HLS },
            { bitrate: 432000, content_type: "video/mp4", url: MP4_320 },
            { bitrate: 1280000, content_type: "video/mp4", url: MP4_720 },
            { bitrate: 832000, content_type: "video/mp4", url: MP4_540 },
          ],
        },
      }),
    );
    // `url` still means the poster image: the photo path renders it, and losing it would trade a
    // preview for a link.
    expect(t.media).toEqual([{ type: "video", url: VIDEO_THUMB, videoUrl: MP4_720 }]);
  });

  it("never selects the HLS playlist, even when it is the only variant", () => {
    const t = normalizeTweet(
      videoTweet({ video_info: { variants: [{ content_type: "application/x-mpegURL", url: HLS }] } }),
    );
    expect(t.media).toStrictEqual([{ type: "video", url: VIDEO_THUMB }]);
  });

  it("takes a bitrate-less mp4 when it is the only one, and ranks it below any bitrated mp4", () => {
    // An animated_gif's single variant arrives without `bitrate` in the wild. It is a legitimate
    // playable mp4, so it must be selected — just never in preference to one that states a bitrate.
    const only = normalizeTweet(
      videoTweet({ type: "animated_gif", video_info: { variants: [{ content_type: "video/mp4", url: MP4_320 }] } }),
    );
    expect(only.media).toEqual([{ type: "animated_gif", url: VIDEO_THUMB, videoUrl: MP4_320 }]);

    const alongside = normalizeTweet(
      videoTweet({
        video_info: {
          variants: [
            { content_type: "video/mp4", url: MP4_320 },
            { bitrate: 832000, content_type: "video/mp4", url: MP4_540 },
          ],
        },
      }),
    );
    expect(alongside.media?.[0].videoUrl).toBe(MP4_540);
  });

  it("keeps the first of two mp4s that tie on bitrate rather than throwing", () => {
    const t = normalizeTweet(
      videoTweet({
        video_info: {
          variants: [
            { bitrate: 832000, content_type: "video/mp4", url: MP4_540 },
            { bitrate: 832000, content_type: "video/mp4", url: MP4_720 },
          ],
        },
      }),
    );
    expect(t.media?.[0].videoUrl).toBe(MP4_540);
  });

  it("leaves videoUrl absent when there is no mp4 to point at, without throwing", () => {
    const shapes: Record<string, unknown>[] = [
      {}, // no video_info at all — what a photo entry looks like
      { video_info: { variants: [] } },
      { video_info: { variants: null } },
      { video_info: null },
      { video_info: { variants: [{ bitrate: 832000, content_type: "video/mp4" }] } }, // no url
      { video_info: { variants: [{ bitrate: 832000, content_type: "video/webm", url: MP4_540 }] } },
      { video_info: { variants: [{ url: MP4_540 }] } }, // no content_type: not provably an mp4
    ];
    for (const shape of shapes) {
      expect(normalizeTweet(videoTweet(shape)).media).toStrictEqual([{ type: "video", url: VIDEO_THUMB }]);
    }
  });

  it("leaves a photo entry exactly as it was — no videoUrl key at all", () => {
    const t = normalizeTweet(rawTweet);
    expect(t.media).toStrictEqual([{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]);
  });
});

describe("parseTweetList", () => {
  it("extracts tweets, hasNextPage, nextCursor with defaults", () => {
    const parsed = parseTweetList({ tweets: [rawTweet], has_next_page: true, next_cursor: "c1" });
    expect(parsed.tweets).toHaveLength(1);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.nextCursor).toBe("c1");
  });

  it("defaults missing pagination fields", () => {
    const parsed = parseTweetList({ tweets: [] });
    expect(parsed.hasNextPage).toBe(false);
    expect(parsed.nextCursor).toBe("");
  });

  it("tolerates null pagination fields (last page of the live API)", () => {
    const parsed = parseTweetList({ tweets: null, has_next_page: false, next_cursor: null });
    expect(parsed.tweets).toEqual([]);
    expect(parsed.hasNextPage).toBe(false);
    expect(parsed.nextCursor).toBe("");
  });
});

describe("normalizeTweet — articles", () => {
  it("maps the article summary that rides on a search result, without a body", () => {
    const t = normalizeTweet({
      ...rawTweet,
      text: "https://t.co/pa1EbjOsdZ",
      article: {
        title: "Phase 1: ClawHack",
        preview_text: "AI isn't just a narrative anymore.",
        cover_media_img_url: "https://pbs.twimg.com/media/HFjTzAgaQAA1DzU.jpg",
      },
    });
    expect(t.article?.title).toBe("Phase 1: ClawHack");
    expect(t.article?.previewText).toBe("AI isn't just a narrative anymore.");
    expect(t.article?.coverImageUrl).toBe("https://pbs.twimg.com/media/HFjTzAgaQAA1DzU.jpg");
    // The search response never carries the body.
    expect(t.article?.blocks).toBeUndefined();
  });

  it("leaves article undefined for an ordinary tweet, including an explicit null", () => {
    expect(normalizeTweet(rawTweet).article).toBeUndefined();
    expect(normalizeTweet({ ...rawTweet, article: null }).article).toBeUndefined();
  });
});

describe("normalizeTweet — quoted-tweet link", () => {
  const base = {
    id: "1",
    url: "https://x.com/Mantle_Official/status/1",
    createdAt: "Mon Jun 29 05:58:17 +0000 2026",
    author: { userName: "Mantle_Official" },
  };

  it("appends the quoted tweet's url after the text when it is not already there", () => {
    const t = normalizeTweet({
      ...base,
      text: "The full breakdown ↓",
      quoted_tweet: { id: "999", url: "https://x.com/quoted_acct/status/999" },
    });
    expect(t.text).toBe("The full breakdown ↓\nhttps://x.com/quoted_acct/status/999");
    expect(t.isQuote).toBe(true);
  });

  it("does not duplicate a quoted url the text already contains", () => {
    const t = normalizeTweet({
      ...base,
      text: "see https://x.com/quoted_acct/status/999",
      quoted_tweet: { id: "999", url: "https://x.com/quoted_acct/status/999" },
    });
    expect(t.text).toBe("see https://x.com/quoted_acct/status/999");
  });

  it("does not append when the text already contains the quoted tweet's id (t.co-expanded)", () => {
    const t = normalizeTweet({
      ...base,
      text: "context https://twitter.com/quoted_acct/status/999",
      quoted_tweet: { id: "999", url: "https://x.com/quoted_acct/status/999" },
    });
    expect(t.text).toBe("context https://twitter.com/quoted_acct/status/999");
  });

  it("leaves text unchanged when the quoted tweet has no url (still isQuote)", () => {
    const t = normalizeTweet({ ...base, text: "hi", quoted_tweet: { id: "999" } });
    expect(t.text).toBe("hi");
    expect(t.isQuote).toBe(true);
  });

  it("leaves text unchanged and isQuote false when there is no quoted tweet", () => {
    const t = normalizeTweet({ ...base, text: "hi" });
    expect(t.text).toBe("hi");
    expect(t.isQuote).toBe(false);
  });

  it("tolerates an unknown extra field on quoted_tweet (passthrough)", () => {
    const t = normalizeTweet({
      ...base,
      text: "hi",
      quoted_tweet: { id: "999", url: "https://x.com/a/status/999", futureKey: "x" },
    });
    expect(t.text).toBe("hi\nhttps://x.com/a/status/999");
  });
});

describe("parseArticle", () => {
  /** The blocks alone, for the tests below that are only about block handling. */
  const blocksOf = (data: unknown) => parseArticle(data)?.blocks ?? [];

  it("extracts the content blocks from a GET /twitter/article response", () => {
    const blocks = blocksOf({
      status: "success",
      msg: "success",
      article: {
        title: "Phase 1: ClawHack",
        viewCount: "90334", // a string here, a number on the tweet endpoint — must not be assumed
        contents: [
          { type: "header-two", text: "Introducing The Turing Test Hackathon" },
          { type: "unstyled", text: "Bold me", inlineStyleRanges: [{ offset: 0, length: 4, style: "Bold" }] },
          { type: "divider" },
          { type: "image", url: "https://pbs.twimg.com/media/x.jpg", width: 1280, height: 720 },
        ],
      },
    });

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "header-two", text: "Introducing The Turing Test Hackathon" });
    expect(blocks[1].inlineStyleRanges).toEqual([{ offset: 0, length: 4, style: "Bold" }]);
    expect(blocks[2]).toEqual({ type: "divider" });
    expect(blocks[3].url).toBe("https://pbs.twimg.com/media/x.jpg");
  });

  it("carries the article's own title, excerpt and cover image, not just its blocks", () => {
    // These three are the whole reason this returns an ArticleBody. A tweet from
    // `/twitter/tweet/thread_context` — the endpoint 링크 수집 reads — has no `article` key, so
    // this response is the only place they exist for a linked article: `renderArticle` needs the
    // title and `pgXArticleMeta` reads the cover to send the translation back out as an X Article.
    expect(
      parseArticle({
        article: {
          title: "A Comprehensive Guide",
          preview_text: "In 2026, there are plenty of chains",
          cover_media_img_url: "https://pbs.twimg.com/media/cover.jpg",
          contents: [{ type: "unstyled", text: "body" }],
        },
      }),
    ).toEqual({
      title: "A Comprehensive Guide",
      previewText: "In 2026, there are plenty of chains",
      coverImageUrl: "https://pbs.twimg.com/media/cover.jpg",
      blocks: [{ type: "unstyled", text: "body" }],
    });
  });

  it("answers undefined for a tweet that is not an article", () => {
    // The live shape, quoted: a plain tweet id answers `{"article":null,"status":"failed"}`. This
    // has to be distinguishable from an article whose every block was malformed, which is what a
    // bare `[]` could not say — `CollectLinkedThread` warns "keeping link only" for the second and
    // must stay silent about the first.
    expect(parseArticle({ status: "failed", msg: "article not found", article: null })).toBeUndefined();
  });

  it("returns an article with no blocks when the response carries no contents", () => {
    expect(parseArticle({ article: { title: "t" } })).toEqual({
      title: "t",
      previewText: undefined,
      coverImageUrl: undefined,
      blocks: [],
    });
  });

  it("keeps an article that arrived without a title rather than dropping its body", () => {
    expect(parseArticle({ article: { contents: [{ type: "unstyled", text: "body" }] } })?.title).toBe("");
  });

  it("skips a malformed block instead of rejecting the whole article", () => {
    const blocks = blocksOf({
      article: { contents: [{ type: "unstyled", text: "kept" }, { text: "no type" }, { type: "unstyled", text: "also kept" }] },
    });
    expect(blocks.map((b) => b.text)).toEqual(["kept", "also kept"]);
  });

  it("keeps an unrecognised key on an inline style range instead of discarding it", () => {
    // Same rationale as ArticleBlockRaw's passthrough, one level down: InlineStyleRangeRaw was a
    // plain z.object, so a key twitterapi.io adds to a range in the future would be silently
    // stripped and, since blocks are never re-fetched once stored, unrecoverable without a
    // re-collect.
    const blocks = blocksOf({
      article: {
        contents: [
          {
            type: "unstyled",
            text: "hi",
            inlineStyleRanges: [{ offset: 0, length: 2, style: "Bold", futureKey: "x" }],
          },
        ],
      },
    });
    expect((blocks[0].inlineStyleRanges?.[0] as unknown as Record<string, unknown>)["futureKey"]).toBe("x");
  });

  it("keeps an unrecognised key (e.g. entityRanges) on the stored block instead of discarding it", () => {
    // The design spec's "Known limitations" names entityRanges as the one thing it cannot yet map
    // correctly — but the mapping can only ever be corrected later if the key survives collection.
    const blocks = blocksOf({
      article: {
        contents: [
          { type: "unstyled", text: "hi", entityRanges: [{ offset: 0, length: 2, key: 0 }] },
        ],
      },
    });
    expect((blocks[0] as unknown as Record<string, unknown>)["entityRanges"]).toEqual([
      { offset: 0, length: 2, key: 0 },
    ]);
  });
});
