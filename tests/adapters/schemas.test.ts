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
});
