import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalJsonStore } from "../../src/adapters/store/LocalJsonStore";
import type { CollectedThread } from "../../src/domain/models";

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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "herald-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalJsonStore", () => {
  it("upsert then loadAll round-trips", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1"])]);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("upsert merges by rootId and preserves original firstSeenAt", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1"], { firstSeenAt: "2026-01-01T00:00:00.000Z" })]);
    await store.upsert([thread("1", ["1", "2"], { firstSeenAt: "2026-02-02T00:00:00.000Z" })]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].tweets).toHaveLength(2);
    expect(all[0].firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // preserved
  });

  it("listActiveTweetIds returns ids of active threads only", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1", "2"]), thread("9", ["9"], { status: "deleted" })]);
    expect((await store.listActiveTweetIds()).sort()).toEqual(["1", "2"]);
  });

  it("markDeleted flags the containing thread with deletedAt", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1", "2"])]);
    await store.markDeleted(["2"], "2026-03-03T00:00:00.000Z");
    const all = await store.loadAll();
    expect(all[0].status).toBe("deleted");
    expect(all[0].deletedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("upsert preserves stored tweets when a later upsert supplies a subset of the thread", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1", "2"])]);
    await store.upsert([thread("1", ["2"])]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(
      all[0].tweets.map((t) => t.id).sort(),
    ).toEqual(["1", "2"]); // tweet "1" must not be dropped
  });

  it("upsert lets the incoming tweet win for a duplicate id", async () => {
    const store = new LocalJsonStore(dir);
    const first: CollectedThread = {
      rootId: "1",
      tweets: [
        {
          id: "1",
          conversationId: "1",
          text: "old",
          createdAt: "2026-01-01T00:00:00.000Z",
          url: "u/1",
          authorUserName: "Mantle_Official",
          isReply: false,
          isQuote: false,
        },
      ],
      status: "active",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const second: CollectedThread = {
      ...first,
      tweets: [{ ...first.tweets[0], text: "new" }],
    };
    await store.upsert([first]);
    await store.upsert([second]);
    const all = await store.loadAll();
    expect(all[0].tweets.find((t) => t.id === "1")?.text).toBe("new");
  });

  it("upsert preserves a stored article body when the incoming tweet carries no article field at all", async () => {
    // Mirrors a gap-fill via fetchThread (thread_context): the endpoint never returns `article`,
    // so a re-collect must not let that silently erase the stored body.
    const store = new LocalJsonStore(dir);
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
    const store = new LocalJsonStore(dir);
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
    // of the previous test. No current path produces blocks: [] on an incoming tweet, but the
    // truthiness check that used to guard this (`incoming.article?.blocks`) was latently wrong.
    const store = new LocalJsonStore(dir);
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

  it("watermark get returns undefined initially, then the set value", async () => {
    const store = new LocalJsonStore(dir);
    expect(await store.get("acct")).toBeUndefined();
    await store.set("acct", "2026-04-04T00:00:00.000Z");
    expect(await store.get("acct")).toBe("2026-04-04T00:00:00.000Z");
  });

  it("loadAll rejects on a corrupt items.json instead of silently returning [] (which would cause upsert to overwrite the store)", async () => {
    const itemsPath = join(dir, "items.json");
    await writeFile(itemsPath, "{ not json", "utf8");
    const store = new LocalJsonStore(dir);

    await expect(store.loadAll()).rejects.toThrow();

    // The corrupt file must be left untouched -- no silent overwrite.
    expect(await readFile(itemsPath, "utf8")).toBe("{ not json");
  });

  it("upsert rejects (and does not overwrite) when items.json is corrupt", async () => {
    const itemsPath = join(dir, "items.json");
    await writeFile(itemsPath, "{ not json", "utf8");
    const store = new LocalJsonStore(dir);

    await expect(store.upsert([thread("1", ["1"])])).rejects.toThrow();

    // Must not have discarded the (unreadable) prior content by writing just the new batch.
    expect(await readFile(itemsPath, "utf8")).toBe("{ not json");
  });
});
