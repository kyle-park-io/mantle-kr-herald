import { describe, it, expect } from "vitest";
import { normalizeTweet, parseArticleContents, parseTweetList } from "../../src/adapters/twitterapi/schemas";

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

describe("parseArticleContents", () => {
  it("extracts the content blocks from a GET /twitter/article response", () => {
    const blocks = parseArticleContents({
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

  it("returns an empty array when the response has no article or no contents", () => {
    expect(parseArticleContents({ status: "error", msg: "not found", article: null })).toEqual([]);
    expect(parseArticleContents({ article: { title: "t" } })).toEqual([]);
  });

  it("skips a malformed block instead of rejecting the whole article", () => {
    const blocks = parseArticleContents({
      article: { contents: [{ type: "unstyled", text: "kept" }, { text: "no type" }, { type: "unstyled", text: "also kept" }] },
    });
    expect(blocks.map((b) => b.text)).toEqual(["kept", "also kept"]);
  });

  it("keeps an unrecognised key on an inline style range instead of discarding it", () => {
    // Same rationale as ArticleBlockRaw's passthrough, one level down: InlineStyleRangeRaw was a
    // plain z.object, so a key twitterapi.io adds to a range in the future would be silently
    // stripped and, since blocks are never re-fetched once stored, unrecoverable without a
    // re-collect.
    const blocks = parseArticleContents({
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
    const blocks = parseArticleContents({
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
