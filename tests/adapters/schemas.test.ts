import { describe, it, expect } from "vitest";
import { normalizeTweet, parseTweetList } from "../../src/adapters/twitterapi/schemas";

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
