import { describe, it, expect } from "vitest";
import { TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";
import type { IHttpClient } from "../../src/shared/http/IHttpClient";

function raw(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://x.com/Mantle_Official/status/${id}`,
    text: `t${id}`,
    createdAt: "Mon Jun 29 05:58:17 +0000 2026",
    conversationId: id,
    author: { userName: "Mantle_Official" },
    ...extra,
  };
}

class FakeHttpClient implements IHttpClient {
  public calls: { path: string; params?: Record<string, string> }[] = [];
  constructor(private readonly responder: (path: string, params?: Record<string, string>) => unknown) {}
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push({ path, params });
    return this.responder(path, params) as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("not used");
  }
  async patch<T>(): Promise<T> {
    throw new Error("not used");
  }
  async delete<T>(): Promise<T> {
    throw new Error("not used");
  }
}

describe("TwitterApiSourceGateway", () => {
  it("fetchAuthoredTweets builds from: + since_time query and paginates via cursor", async () => {
    const http = new FakeHttpClient((_path, params) => {
      if (!params?.cursor) {
        return { tweets: [raw("1")], has_next_page: true, next_cursor: "c1" };
      }
      return { tweets: [raw("2")], has_next_page: false, next_cursor: "" };
    });
    const gw = new TwitterApiSourceGateway(http);

    const ids: string[] = [];
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official", "2026-06-29T00:00:00.000Z")) {
      ids.push(t.id);
    }

    expect(ids).toEqual(["1", "2"]);
    expect(http.calls[0].path).toBe("/twitter/tweet/advanced_search");
    const query = http.calls[0].params?.query ?? "";
    expect(query).toContain("from:Mantle_Official");
    expect(query).toContain("since_time:"); // watermark converted to unix seconds
  });

  it("fetchAuthoredTweets omits since_time when no watermark", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], has_next_page: false, next_cursor: "" }));
    const gw = new TwitterApiSourceGateway(http);
    for await (const _ of gw.fetchAuthoredTweets("Mantle_Official")) { /* drain */ }
    expect(http.calls[0].params?.query).toBe("from:Mantle_Official");
  });

  it("fetchThread paginates thread_context and returns normalized tweets", async () => {
    const http = new FakeHttpClient((_path, params) =>
      params?.cursor
        ? { tweets: [raw("b")], has_next_page: false, next_cursor: "" }
        : { tweets: [raw("a")], has_next_page: true, next_cursor: "c" },
    );
    const gw = new TwitterApiSourceGateway(http);
    const tweets = await gw.fetchThread("a");
    expect(tweets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(http.calls[0].path).toBe("/twitter/tweet/thread_context");
    expect(http.calls[0].params?.tweetId).toBe("a");
  });

  it("stops at the watermark: yields only tweets newer than sinceTime and fetches no more pages", async () => {
    const newer = raw("new", { createdAt: "Mon Jun 29 05:58:17 +0000 2026" });
    const older = raw("old", { createdAt: "Sun Jun 28 05:58:17 +0000 2026" });
    // has_next_page is true, but the older tweet is at/before the watermark, so we must stop.
    const http = new FakeHttpClient(() => ({ tweets: [newer, older], has_next_page: true, next_cursor: "c1" }));
    const gw = new TwitterApiSourceGateway(http);
    const ids: string[] = [];
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official", "2026-06-29T00:00:00.000Z")) ids.push(t.id);
    expect(ids).toEqual(["new"]);
    expect(http.calls).toHaveLength(1); // did NOT request page 2 despite has_next_page
  });

  it("stops when the cursor stops advancing (guards against an infinite pagination loop)", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], has_next_page: true, next_cursor: "stuck" }));
    const gw = new TwitterApiSourceGateway(http);
    let count = 0;
    for await (const _ of gw.fetchAuthoredTweets("Mantle_Official")) count++;
    expect(http.calls.length).toBe(2); // page 1 (cursor ""), page 2 (cursor "stuck"), then cursor repeats → stop
  });

  it("skips a malformed tweet instead of aborting the whole batch", async () => {
    const bad = { url: "u", text: "t", createdAt: "Mon Jun 29 05:58:17 +0000 2026" }; // missing required id
    const http = new FakeHttpClient(() => ({
      tweets: [raw("1"), bad, raw("2")],
      has_next_page: false,
      next_cursor: "",
    }));
    const gw = new TwitterApiSourceGateway(http);
    const ids: string[] = [];
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official")) ids.push(t.id);
    expect(ids).toEqual(["1", "2"]);
  });

  it("fetchAuthoredTweets returns true when it hits the MAX_PAGES cap with more pages available", async () => {
    // Every page reports has_next_page: true with an advancing cursor, so the loop
    // runs all MAX_PAGES (50) iterations and falls out the bottom instead of
    // reaching a natural stop.
    const http = new FakeHttpClient((_path, params) => {
      const cursor = params?.cursor ?? "";
      const next = `${cursor}x`;
      return { tweets: [raw(`t${next}`)], has_next_page: true, next_cursor: next };
    });
    const gw = new TwitterApiSourceGateway(http);

    const it_ = gw.fetchAuthoredTweets("Mantle_Official");
    let r = await it_.next();
    while (!r.done) r = await it_.next();

    expect(r.value).toBe(true);
    expect(http.calls.length).toBe(50);
  });

  it("fetchAuthoredTweets returns false on a natural stop (has_next_page: false)", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], has_next_page: false, next_cursor: "" }));
    const gw = new TwitterApiSourceGateway(http);

    const it_ = gw.fetchAuthoredTweets("Mantle_Official");
    let r = await it_.next();
    while (!r.done) r = await it_.next();

    expect(r.value).toBe(false);
  });

  it("fetchByIds sends comma-separated tweet_ids and returns alive tweets", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], status: "success" }));
    const gw = new TwitterApiSourceGateway(http);
    const tweets = await gw.fetchByIds(["1", "2"]);
    expect(tweets.map((t) => t.id)).toEqual(["1"]);
    expect(http.calls[0].path).toBe("/twitter/tweets");
    expect(http.calls[0].params?.tweet_ids).toBe("1,2");
  });

  it("fetchArticle calls /twitter/article with a snake_case tweet_id and returns the blocks", async () => {
    const http = new FakeHttpClient(() => ({
      status: "success",
      article: { title: "T", contents: [{ type: "header-one", text: "Hello" }, { type: "divider" }] },
    }));
    const gw = new TwitterApiSourceGateway(http);

    const blocks = await gw.fetchArticle("2042617042537451733");

    expect(http.calls).toEqual([
      { path: "/twitter/article", params: { tweet_id: "2042617042537451733" } },
    ]);
    expect(blocks).toEqual([{ type: "header-one", text: "Hello" }, { type: "divider" }]);
  });
});
