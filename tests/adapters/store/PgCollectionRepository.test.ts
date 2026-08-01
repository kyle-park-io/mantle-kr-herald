import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgCollectionRepository } from "../../../src/adapters/store/PgCollectionRepository";
import type { CollectedThread } from "../../../src/domain/models";

function thread(rootId: string, ids: string[], overrides: Partial<CollectedThread> = {}): CollectedThread {
  return {
    rootId,
    tweets: ids.map((id) => ({
      id,
      conversationId: rootId,
      text: `t${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      url: `u/${id}`,
      authorUserName: "Mantle_Official",
      isReply: false,
      isQuote: false,
    })),
    status: "active",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("PgCollectionRepository", () => {
  it("returns [] when no rows are stored", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    expect(await store.loadAll()).toEqual([]);
  });

  it("upsert then loadAll round-trips", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"])]);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("upsert merges by rootId and preserves original firstSeenAt", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"], { firstSeenAt: "2026-01-01T00:00:00.000Z" })]);
    await store.upsert([thread("1", ["1", "2"], { firstSeenAt: "2026-02-02T00:00:00.000Z" })]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].tweets).toHaveLength(2);
    expect(all[0].firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // preserved
  });

  it("listActiveTweetIds returns ids of active threads only", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1", "2"]), thread("9", ["9"], { status: "deleted" })]);
    expect((await store.listActiveTweetIds()).sort()).toEqual(["1", "2"]);
  });

  it("markDeleted flags the containing thread with deletedAt", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1", "2"])]);
    await store.markDeleted(["2"], "2026-03-03T00:00:00.000Z");
    const all = await store.loadAll();
    expect(all[0].status).toBe("deleted");
    expect(all[0].deletedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("markDeleted does not touch a thread that has no matching tweet id", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"]), thread("2", ["2"])]);
    await store.markDeleted(["1"], "2026-03-03T00:00:00.000Z");
    const all = await store.loadAll();
    expect(all.find((t) => t.rootId === "2")?.status).toBe("active");
    expect(all.find((t) => t.rootId === "2")?.deletedAt).toBeUndefined();
  });

  it("markDeleted is a no-op for an empty id list", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"])]);
    await expect(store.markDeleted([], "2026-03-03T00:00:00.000Z")).resolves.not.toThrow();
    expect((await store.loadAll())[0].status).toBe("active");
  });

  it("upsert preserves stored tweets when a later upsert supplies a subset of the thread", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1", "2"])]);
    await store.upsert([thread("1", ["2"])]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].tweets.map((t) => t.id).sort()).toEqual(["1", "2"]); // tweet "1" must not be dropped
  });

  it("upsert lets the incoming tweet win for a duplicate id", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const first = thread("1", ["1"]);
    const second: CollectedThread = { ...first, tweets: [{ ...first.tweets[0], text: "new" }] };
    await store.upsert([first]);
    await store.upsert([second]);
    const all = await store.loadAll();
    expect(all[0].tweets.find((t) => t.id === "1")?.text).toBe("new");
  });

  it("upsert preserves a stored article body when the incoming tweet carries no article field at all", async () => {
    // Mirrors a gap-fill via fetchThread (thread_context): the endpoint never returns `article`,
    // so a re-collect must not let that silently erase the stored body.
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const withArticle: CollectedThread = {
      rootId: "1",
      tweets: [
        {
          id: "1", conversationId: "1", text: "https://t.co/x", createdAt: "2026-01-01T00:00:00.000Z",
          url: "u/1", authorUserName: "Mantle_Official", isReply: false, isQuote: false,
          article: { title: "T", blocks: [{ type: "unstyled", text: "Body" }] },
        },
      ],
      status: "active",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsert([withArticle]);

    const noArticleField: CollectedThread = {
      ...withArticle,
      tweets: [{ ...withArticle.tweets[0], article: undefined, text: "https://t.co/x" }],
    };
    await store.upsert([noArticleField]);

    const all = await store.loadAll();
    expect(all[0].tweets[0].article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
  });

  it("upsert preserves a stored article body when the incoming article has no blocks (unfetched re-normalize)", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const withArticle: CollectedThread = {
      rootId: "1",
      tweets: [
        {
          id: "1", conversationId: "1", text: "https://t.co/x", createdAt: "2026-01-01T00:00:00.000Z",
          url: "u/1", authorUserName: "Mantle_Official", isReply: false, isQuote: false,
          article: { title: "T", blocks: [{ type: "unstyled", text: "Body" }] },
        },
      ],
      status: "active",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsert([withArticle]);

    const blocklessArticle: CollectedThread = {
      ...withArticle,
      tweets: [{ ...withArticle.tweets[0], article: { title: "T" }, metrics: { likeCount: 5 } }],
    };
    await store.upsert([blocklessArticle]);

    const all = await store.loadAll();
    expect(all[0].tweets[0].article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
    // The rest of the incoming tweet still wins (metrics legitimately change between runs).
    expect(all[0].tweets[0].metrics?.likeCount).toBe(5);
  });

  it("upsert preserves a stored article body when the incoming article carries an empty blocks array", async () => {
    // blocks: [] must count the same as "no body", not as "has a body" — otherwise an incoming
    // empty-blocks article would beat (and permanently discard) a good stored one, the mirror image
    // of the previous test.
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const withArticle: CollectedThread = {
      rootId: "1",
      tweets: [
        {
          id: "1", conversationId: "1", text: "https://t.co/x", createdAt: "2026-01-01T00:00:00.000Z",
          url: "u/1", authorUserName: "Mantle_Official", isReply: false, isQuote: false,
          article: { title: "T", blocks: [{ type: "unstyled", text: "Body" }] },
        },
      ],
      status: "active",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsert([withArticle]);

    const emptyBlocksArticle: CollectedThread = {
      ...withArticle,
      tweets: [{ ...withArticle.tweets[0], article: { title: "T", blocks: [] } }],
    };
    await store.upsert([emptyBlocksArticle]);

    const all = await store.loadAll();
    expect(all[0].tweets[0].article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
  });

  it("upsert lets a freshly fetched article body with real blocks replace a stored one", async () => {
    // Mirror image of the three "preserves a stored article body" tests above: when the incoming
    // article DOES carry blocks, it must win outright, not just lose gracefully when it doesn't.
    // Without this case, a mutant that drops the `blocks?.length` check and always keeps
    // `existing.article` passes every other article test here.
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const withArticle: CollectedThread = {
      rootId: "1",
      tweets: [
        {
          id: "1", conversationId: "1", text: "https://t.co/x", createdAt: "2026-01-01T00:00:00.000Z",
          url: "u/1", authorUserName: "Mantle_Official", isReply: false, isQuote: false,
          article: { title: "T", blocks: [{ type: "unstyled", text: "Body" }] },
        },
      ],
      status: "active",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsert([withArticle]);

    const refetchedArticle: CollectedThread = {
      ...withArticle,
      tweets: [{
        ...withArticle.tweets[0],
        article: {
          title: "T v2",
          blocks: [
            { type: "unstyled", text: "Body" },
            { type: "unstyled", text: "More body, fetched later" },
          ],
        },
      }],
    };
    await store.upsert([refetchedArticle]);

    const all = await store.loadAll();
    expect(all[0].tweets[0].article?.blocks).toEqual([
      { type: "unstyled", text: "Body" },
      { type: "unstyled", text: "More body, fetched later" },
    ]);
    expect(all[0].tweets[0].article?.title).toBe("T v2");
  });

  it("omits deletedAt when absent rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"])]);
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("deletedAt", null);
    expect(row.deletedAt).toBeUndefined();
  });

  it("a single upsert() call merges two distinct new threads in one batch (targeted read, not loadAll)", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"]), thread("2", ["2"])]);
    const all = await store.loadAll();
    expect(all.map((t) => t.rootId).sort()).toEqual(["1", "2"]);
  });

  it("a single upsert() call chains two entries for the same rootId, like LocalJsonStore's running Map", async () => {
    // LocalJsonStore.upsert folds through a `Map`, so a second entry for the same rootId in one
    // batch merges on top of the FIRST entry's result, not pre-batch database state. Both tweets
    // must survive (they don't collide by id) and the earlier firstSeenAt must win, exactly as if
    // the two entries had been upserted one at a time.
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    const first = thread("1", ["1"], { firstSeenAt: "2026-01-01T00:00:00.000Z" });
    const second = thread("1", ["2"], { firstSeenAt: "2026-02-02T00:00:00.000Z" });
    await store.upsert([first, second]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].tweets.map((t) => t.id).sort()).toEqual(["1", "2"]); // tweet "1" must not be dropped
    expect(all[0].firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // first-in-batch value wins
  });

  it("a single upsert() call merges a new thread and an update to an existing thread together", async () => {
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await store.upsert([thread("1", ["1"], { firstSeenAt: "2026-01-01T00:00:00.000Z" })]);
    await store.upsert([
      thread("1", ["1", "2"], { firstSeenAt: "2026-09-09T00:00:00.000Z" }),
      thread("3", ["3"]),
    ]);
    const all = await store.loadAll();
    const t1 = all.find((t) => t.rootId === "1");
    expect(t1?.tweets).toHaveLength(2);
    expect(t1?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // preserved even inside a batch
    expect(all.find((t) => t.rootId === "3")).toBeDefined();
  });

  it("two concurrent upsert() calls for different rootIds both land", async () => {
    // Different rootIds cannot conflict by construction, and PGlite is single-connection, so this
    // does NOT exercise (and must not be read as proving) safety for two concurrent upsert() calls
    // targeting the SAME rootId. See the residual-race paragraph on the class doc comment: that
    // case can still lose one side's merge under READ COMMITTED, because each call's targeted
    // `select` runs before its `on conflict` write.
    db = await createTestDb();
    const store = new PgCollectionRepository(db);
    await Promise.all([store.upsert([thread("1", ["1"])]), store.upsert([thread("2", ["2"])])]);
    const all = await store.loadAll();
    expect(all.map((t) => t.rootId).sort()).toEqual(["1", "2"]);
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgCollectionRepository(localDb);
    await store.upsert([thread("1", ["1"])]);
    await store.upsert([thread("2", ["2"])]);
    await store.upsert([thread("3", ["3"])]);

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from x_threads where root_id = $1",
      ["1"],
    );

    // Update the first-inserted thread last — if `upsert` ever touched `ordinal`, this would move
    // thread "1" to the end of loadAll() and bump its ordinal value.
    await store.upsert([thread("1", ["1", "1b"])]);

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from x_threads where root_id = $1",
      ["1"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((t) => t.rootId)).toEqual(["1", "2", "3"]);
  });
});
