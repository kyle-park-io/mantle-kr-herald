import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_PAGES, TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";
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

    const pages = gw.fetchAuthoredTweets("Mantle_Official");
    let r = await pages.next();
    while (!r.done) r = await pages.next();

    expect(r.value).toBe(true);
    expect(http.calls.length).toBe(50);
  });

  it("fetchAuthoredTweets returns false on a natural stop (has_next_page: false)", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], has_next_page: false, next_cursor: "" }));
    const gw = new TwitterApiSourceGateway(http);

    const pages = gw.fetchAuthoredTweets("Mantle_Official");
    let r = await pages.next();
    while (!r.done) r = await pages.next();

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

  /**
   * twitterapi.io caps `/twitter/tweets` at 50 ids and answers a longer list with
   * `HTTP 400: max 50 tweet_ids per request, please batch into multiple calls`. Measured on
   * 2026-08-19: `pnpm impressions:record` with no arguments failed on every run, because
   * `history` held 74 x rows and `RecordImpressions` handed all 74 to this method at once.
   *
   * The chunking lives here, not in the callers, because the cap belongs to the endpoint. Three
   * callers had to know it independently and two got it wrong — `RecordImpressions` chunked not at
   * all, `ReconcileDeletions` chunked at 100 — while only `BackfillVideoUrls` picked 50. A future
   * fourth caller cannot forget a rule the adapter enforces.
   */
  it("fetchByIds splits a request the endpoint would reject, and merges the pages", async () => {
    const ids = Array.from({ length: 74 }, (_, i) => String(i + 1));
    const http = new FakeHttpClient((_path, params) => ({
      status: "success",
      tweets: (params?.tweet_ids ?? "").split(",").map((id) => raw(id)),
    }));
    const gw = new TwitterApiSourceGateway(http);

    const tweets = await gw.fetchByIds(ids);

    expect(http.calls).toHaveLength(2);
    for (const call of http.calls) {
      expect(call.params?.tweet_ids?.split(",").length).toBeLessThanOrEqual(50);
    }
    // Every id comes back exactly once — a chunk boundary must not drop or duplicate one.
    expect(tweets.map((t) => t.id)).toEqual(ids);
  });

  it("fetchByIds makes one request when the ids fit inside the endpoint's cap", async () => {
    const http = new FakeHttpClient(() => ({ status: "success", tweets: [raw("1"), raw("2")] }));
    const gw = new TwitterApiSourceGateway(http);

    await gw.fetchByIds(["1", "2"]);

    expect(http.calls).toHaveLength(1);
  });

  it("fetchArticle calls /twitter/article with a snake_case tweet_id and returns the whole article", async () => {
    const http = new FakeHttpClient(() => ({
      status: "success",
      article: {
        title: "T",
        cover_media_img_url: "https://pbs.twimg.com/media/cover.jpg",
        contents: [{ type: "header-one", text: "Hello" }, { type: "divider" }],
      },
    }));
    const gw = new TwitterApiSourceGateway(http);

    const article = await gw.fetchArticle("2042617042537451733");

    expect(http.calls).toEqual([
      { path: "/twitter/article", params: { tweet_id: "2042617042537451733" } },
    ]);
    // The metadata travels with the blocks because for a linked article this response is the only
    // place it exists — `thread_context` tweets carry no article key at all.
    expect(article).toEqual({
      title: "T",
      previewText: undefined,
      coverImageUrl: "https://pbs.twimg.com/media/cover.jpg",
      blocks: [{ type: "header-one", text: "Hello" }, { type: "divider" }],
    });
  });

  // --- the page cap is injected, not read from the environment here ----------------------------
  //
  // The default (DEFAULT_MAX_PAGES, 50) is already exercised by "fetchAuthoredTweets returns true
  // when it hits the MAX_PAGES cap" above. These pin the injection: a caller can raise the cap for
  // one run, and nothing in this class touches `process.env` to find out — so the four entry points
  // that build this gateway for unrelated work cannot inherit a backfill's override. Only the last
  // test here goes near `process.env` at all, and only to prove the class ignores it. Reading and
  // validating HERALD_COLLECT_MAX_PAGES lives in `src/cli/collectMaxPages.ts` and is tested in
  // `tests/cli/collectMaxPages.test.ts`.
  describe("maxPages", () => {
    /** Every page reports more pages available, forever, so the loop always runs to the cap. */
    function unboundedHttp(): FakeHttpClient {
      return new FakeHttpClient((_path, params) => {
        const cursor = params?.cursor ?? "";
        const next = `${cursor}x`;
        return { tweets: [raw(`t${next}`)], has_next_page: true, next_cursor: next };
      });
    }

    it("defaults to DEFAULT_MAX_PAGES when no option is passed", async () => {
      const http = unboundedHttp();
      const gw = new TwitterApiSourceGateway(http);

      const pages = gw.fetchAuthoredTweets("Mantle_Official");
      let r = await pages.next();
      while (!r.done) r = await pages.next();

      expect(r.value).toBe(true);
      expect(DEFAULT_MAX_PAGES).toBe(50);
      expect(http.calls.length).toBe(DEFAULT_MAX_PAGES);
    });

    it("honours an injected cap — the real reason this exists: recovering a GAP needs more than 50 pages", async () => {
      const http = unboundedHttp();
      const gw = new TwitterApiSourceGateway(http, { maxPages: 75 });

      const pages = gw.fetchAuthoredTweets("Mantle_Official");
      let r = await pages.next();
      while (!r.done) r = await pages.next();

      expect(r.value).toBe(true);
      expect(http.calls.length).toBe(75);
    });

    it("also caps fetchThread — the same constant, the same option, the same safety backstop", async () => {
      const http = unboundedHttp();
      const gw = new TwitterApiSourceGateway(http, { maxPages: 3 });

      const tweets = await gw.fetchThread("root");

      expect(tweets.length).toBe(3);
      expect(http.calls.length).toBe(3);
    });

    it("ignores HERALD_COLLECT_MAX_PAGES in the environment — the CLI reads it, not this class", async () => {
      // The regression this guards: the constructor used to read `process.env` itself, so setting
      // the variable for a hand-run backfill silently re-capped `tm:measure`, `metrics:record`,
      // `impressions:record` and `reconcile` too, for the rest of that shell session.
      const original = process.env.HERALD_COLLECT_MAX_PAGES;
      process.env.HERALD_COLLECT_MAX_PAGES = "7";
      try {
        const http = unboundedHttp();
        const gw = new TwitterApiSourceGateway(http);

        const pages = gw.fetchAuthoredTweets("Mantle_Official");
        let r = await pages.next();
        while (!r.done) r = await pages.next();

        expect(http.calls.length).toBe(DEFAULT_MAX_PAGES);
      } finally {
        if (original === undefined) delete process.env.HERALD_COLLECT_MAX_PAGES;
        else process.env.HERALD_COLLECT_MAX_PAGES = original;
      }
    });
  });
});
