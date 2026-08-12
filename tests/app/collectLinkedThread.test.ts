import { describe, it, expect } from "vitest";
import {
  CollectLinkedThread,
  INTAKE_BAD_URL,
  INTAKE_NOT_FOUND,
  INTAKE_REPLY,
  intakeBelowFloorMessage,
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
  // Counted, not inferred from `rows`: "refused before anything was written" is the claim, and an
  // upsert of an empty array would leave `rows` unchanged while still having reached the store.
  const calls = { upsert: 0 };
  const repo: CollectionRepository & { rows: CollectedThread[]; calls: typeof calls } = {
    rows,
    calls,
    loadAll: async () => rows,
    upsert: async (threads) => { calls.upsert += 1; for (const t of threads) rows.push(t); },
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

  /**
   * The one case the per-account floor rule cannot let through. `PrepareTranslations` applies the
   * translate floor to the swept account's posts — a pre-floor one of those is indistinguishable
   * from swept backlog — so collecting it here would put a row in the waiting list that no tick will
   * ever pick up, with no error anywhere. Refused at the door instead, naming the date, which is the
   * same call `isCommenterReply` gets a few lines above and for the same reason.
   */
  describe("the translate floor", () => {
    const FLOOR = "2026-07-27T14:35:25.000Z"; // the live value, deploy/herald-watch.service
    const OLD = "2026-07-01T00:00:00.000Z";
    const reportsFloor = async () => ({ floor: FLOOR, at: "2026-08-12T08:17:00.000Z" });

    it("refuses a swept-account post older than the floor, writing nothing", async () => {
      const repo = fakeRepo();
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD })] }),
        repo,
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      await expect(uc.run(URL_100)).rejects.toThrow(intakeBelowFloorMessage(FLOOR));
      expect(repo.calls.upsert).toBe(0);
    });

    it("names the floor date, so the operator can see which dial moves it", async () => {
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD })] }),
        fakeRepo(),
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      await expect(uc.run(URL_100)).rejects.toThrow(FLOOR);
      await expect(uc.run(URL_100)).rejects.toThrow("HERALD_TRANSLATE_SINCE");
    });

    it("collects a below-floor post from any other account", async () => {
      // The whole point of the rule: nothing but this tab can put another account's thread in
      // `x_threads`, so there is no backlog behind it and the floor has nothing to hold back.
      const repo = fakeRepo();
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD, authorUserName: "someone_else" })] }),
        repo,
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      expect((await uc.run(URL_100)).outcome).toBe("collected");
      expect(repo.calls.upsert).toBe(1);
    });

    it("collects a swept-account post at the floor", async () => {
      // `applySelector` selects with `>=`, so the instant itself is inside the window — refusing it
      // here would refuse a post the next tick would have translated.
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: FLOOR })] }),
        fakeRepo(),
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      expect((await uc.run(URL_100)).outcome).toBe("collected");
    });

    it("reads the ROOT tweet's date, not the linked one's", async () => {
      // A link to the newest tweet of an old thread is still that old thread — `flattenXThreads`
      // takes `createdAt` from the root, so this must ask the same tweet or the two disagree.
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [
          tweet({ id: "100", createdAt: OLD }),
          tweet({ id: "101", conversationId: "100", createdAt: "2026-08-12T00:00:00.000Z" }),
        ] }),
        fakeRepo(),
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      await expect(uc.run("https://x.com/Mantle_Official/status/101")).rejects.toThrow(
        intakeBelowFloorMessage(FLOOR),
      );
    });

    it("reads the root tweet's author, not the handle in the url", async () => {
      // `https://x.com/i/status/<id>` is a real form — it is the one `itemUrl()` builds for every
      // row of 1차 검수 — and its "handle" is the literal `i`. Judging by the url would let a
      // pre-floor swept-account post in under that spelling, straight into the silent drop.
      const repo = fakeRepo();
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD })] }),
        repo,
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        reportsFloor,
      );

      await expect(uc.run("https://x.com/i/status/100")).rejects.toThrow(intakeBelowFloorMessage(FLOOR));
      expect(repo.calls.upsert).toBe(0);
    });

    it("collects normally when no floor is known", async () => {
      // Nothing has been reported (a deployment whose scheduler has never ticked), so there is no
      // floor to be below. Inventing a default here would refuse posts on a guess.
      const repo = fakeRepo();
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD })] }),
        repo,
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        async () => undefined,
      );

      expect((await uc.run(URL_100)).outcome).toBe("collected");
      expect(repo.calls.upsert).toBe(1);
    });

    it("collects normally when the scheduler reported running with no floor", async () => {
      // The alarming state, and not this use case's to report: a tick with no floor selects the
      // whole backlog, so nothing here is below anything.
      const uc = new CollectLinkedThread(
        fakeGateway({ fetchThread: async () => [tweet({ createdAt: OLD })] }),
        fakeRepo(),
        fakeTranslations(),
        () => "2026-08-12T09:00:00.000Z",
        async () => ({ at: "2026-08-12T08:17:00.000Z" }),
      );

      expect((await uc.run(URL_100)).outcome).toBe("collected");
    });
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
