import { describe, it, expect } from "vitest";
import {
  CollectLinkedThread,
  INTAKE_BAD_URL,
  INTAKE_NOT_FOUND,
  INTAKE_REPLY,
} from "../../src/app/CollectLinkedThread";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { ArticleBlock, CollectedThread, SourceTweet } from "../../src/domain/models";

const tweet = (over: Partial<SourceTweet> = {}): SourceTweet => ({
  id: "100",
  conversationId: "100",
  text: "Mantle ships something",
  createdAt: "2026-08-12T00:00:00.000Z",
  url: "https://x.com/Mantle_Official/status/100",
  authorUserName: "Mantle_Official",
  isReply: false,
  isQuote: false,
  ...over,
});

/** A gateway whose every method is a controllable stub. Unset methods throw, so a test that reaches
 *  one it did not arrange fails loudly instead of silently reading undefined. */
function fakeGateway(over: Partial<SourceGateway> = {}): SourceGateway {
  return {
    fetchAuthoredTweets: () => { throw new Error("not arranged"); },
    fetchThread: async () => { throw new Error("not arranged"); },
    fetchByIds: async () => { throw new Error("not arranged"); },
    fetchArticle: async () => [] as ArticleBlock[],
    fetchUserProfile: async () => { throw new Error("not arranged"); },
    ...over,
  } as SourceGateway;
}

function fakeRepo(initial: CollectedThread[] = []) {
  const rows = [...initial];
  const repo: CollectionRepository & { rows: CollectedThread[] } = {
    rows,
    loadAll: async () => rows,
    upsert: async (threads) => { for (const t of threads) rows.push(t); },
    listActiveTweetIds: async () => [],
    markDeleted: async () => {},
  };
  return repo;
}

const fakeTranslations = (ids: string[] = []): TranslationStore => ({
  loadAll: async () => [],
  upsert: async () => {},
  listTranslatedIds: async () => new Set(ids),
});

const URL_100 = "https://x.com/Mantle_Official/status/100";

describe("CollectLinkedThread", () => {
  it("collects a thread and reports the item id", async () => {
    const repo = fakeRepo();
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet(), tweet({ id: "101" })] }),
      repo,
      fakeTranslations(),
      () => "2026-08-12T09:00:00.000Z",
    );

    const result = await uc.run(URL_100);

    expect(result).toEqual({ itemId: "x:100", tweets: 2, outcome: "collected" });
    expect(repo.rows).toEqual([
      {
        rootId: "100",
        tweets: [tweet(), tweet({ id: "101" })],
        status: "active",
        firstSeenAt: "2026-08-12T09:00:00.000Z",
      },
    ]);
  });

  it("refuses a url that is not an x.com post", async () => {
    const uc = new CollectLinkedThread(fakeGateway(), fakeRepo(), fakeTranslations());
    await expect(uc.run("https://example.com/hello")).rejects.toThrow(INTAKE_BAD_URL);
  });

  it("refuses when the thread comes back empty", async () => {
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [] }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_NOT_FOUND);
  });

  it("refuses when no assembled thread carries the requested root id", async () => {
    // The gateway answered, but with a different conversation — writing this would file the wrong post.
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet({ id: "999", conversationId: "999" })] }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_NOT_FOUND);
  });

  it("collects the whole thread from a link to a tweet in the middle of it", async () => {
    // Copying the address of the second tweet is the ordinary way to link "that thread" — x.com's
    // own share menu offers it on every tweet. `parsePostUrl` reads the id in the url, which is that
    // tweet's, never the conversation's, so matching on it as if it were the root told the operator
    // the post was "deleted or private" while it was neither.
    const repo = fakeRepo();
    const root = tweet({ id: "100" });
    const second = tweet({ id: "101", conversationId: "100", createdAt: "2026-08-12T00:01:00.000Z" });
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [root, second] }),
      repo,
      fakeTranslations(),
      () => "2026-08-12T09:00:00.000Z",
    );

    const result = await uc.run("https://x.com/Mantle_Official/status/101");

    // Filed under the thread's real root, which is exactly what a timeline sweep of it would store —
    // an item id derived from the linked tweet would be a second row for one thread.
    expect(result).toEqual({ itemId: "x:100", tweets: 2, outcome: "collected" });
    expect(repo.rows.map((r) => r.rootId)).toEqual(["100"]);
  });

  it("refuses a thread that opens with a commenter reply", async () => {
    // flattenXThreads drops these silently; refusing here is the whole point.
    const repo = fakeRepo();
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet({ isReply: true, text: "@someone agreed" })] }),
      repo,
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow(INTAKE_REPLY);
    expect(repo.rows).toEqual([]);
  });

  it("lets the gateway's own failure through", async () => {
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => { throw new Error("x api 502"); } }),
      fakeRepo(),
      fakeTranslations(),
    );
    await expect(uc.run(URL_100)).rejects.toThrow("x api 502");
  });

  it("reports already-pending for a thread already collected but not translated", async () => {
    const repo = fakeRepo([
      { rootId: "100", tweets: [tweet()], status: "active", firstSeenAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet()] }),
      repo,
      fakeTranslations(),
    );

    const result = await uc.run(URL_100);

    expect(result.outcome).toBe("already-pending");
    // Re-collected anyway: the thread may have grown a tail since it was first seen.
    expect(repo.rows).toHaveLength(2);
  });

  it("reports already-translated when a translation row exists", async () => {
    const repo = fakeRepo([
      { rootId: "100", tweets: [tweet()], status: "active", firstSeenAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const uc = new CollectLinkedThread(
      fakeGateway({ fetchThread: async () => [tweet()] }),
      repo,
      fakeTranslations(["x:100"]),
    );

    expect((await uc.run(URL_100)).outcome).toBe("already-translated");
  });

  it("fetches the article body for an article tweet that arrived without one", async () => {
    const blocks: ArticleBlock[] = [{ type: "paragraph", text: "body" } as unknown as ArticleBlock];
    let asked = "";
    const uc = new CollectLinkedThread(
      fakeGateway({
        fetchThread: async () => [tweet({ article: { title: "t" } as SourceTweet["article"] })],
        fetchArticle: async (id) => { asked = id; return blocks; },
      }),
      fakeRepo(),
      fakeTranslations(),
    );

    await uc.run(URL_100);

    expect(asked).toBe("100");
  });
});
