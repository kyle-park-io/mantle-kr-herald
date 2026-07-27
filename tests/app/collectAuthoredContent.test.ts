import { describe, it, expect } from "vitest";
import { CollectAuthoredContent } from "../../src/app/CollectAuthoredContent";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";
import type { CollectionRunLedger } from "../../src/ports/CollectionRunLedger";
import type { CollectionRun } from "../../src/domain/coverage";
import type { ArticleBlock, CollectedThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, over: Partial<SourceTweet> = {}): SourceTweet {
  return {
    id,
    conversationId: over.conversationId ?? id,
    text: `t${id}`,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    url: `u/${id}`,
    authorUserName: over.authorUserName ?? "Mantle_Official",
    isReply: over.isReply ?? false,
    isQuote: false,
    article: over.article,
  };
}

class FakeGateway implements SourceGateway {
  public threadCalls: string[] = [];
  public lastSince: string | undefined;
  public exhausted = false;
  public articleCalls: string[] = [];
  public articles: Record<string, ArticleBlock[]> = {};
  public articleError: Error | undefined;
  constructor(
    private readonly authored: SourceTweet[],
    private readonly threads: Record<string, SourceTweet[]> = {},
  ) {}
  async *fetchAuthoredTweets(_userName: string, sinceTime?: string): AsyncGenerator<SourceTweet, boolean> {
    this.lastSince = sinceTime;
    for (const t of this.authored) yield t;
    return this.exhausted;
  }
  async fetchThread(id: string): Promise<SourceTweet[]> {
    this.threadCalls.push(id);
    return this.threads[id] ?? [];
  }
  async fetchByIds(): Promise<SourceTweet[]> {
    return [];
  }
  async fetchArticle(tweetId: string): Promise<ArticleBlock[]> {
    this.articleCalls.push(tweetId);
    if (this.articleError) throw this.articleError;
    return this.articles[tweetId] ?? [];
  }
}

class InMemoryRepo implements CollectionRepository {
  public saved: CollectedThread[] = [];
  async loadAll() {
    return this.saved;
  }
  async upsert(threads: CollectedThread[]) {
    this.saved = threads;
  }
  async listActiveTweetIds() {
    return [];
  }
  async markDeleted() {}
}

class InMemoryWatermark implements WatermarkStore {
  public marks = new Map<string, string>();
  async get(key: string) {
    return this.marks.get(key);
  }
  async set(key: string, time: string) {
    this.marks.set(key, time);
  }
}

class InMemoryLedger implements CollectionRunLedger {
  public runs: CollectionRun[] = [];
  async record(run: CollectionRun) {
    this.runs.push(run);
  }
}

describe("CollectAuthoredContent", () => {
  it("collects, assembles, saves, and advances the watermark to max createdAt", async () => {
    const gw = new FakeGateway([
      tw("1", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("2", { conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" }),
    ]);
    const repo = new InMemoryRepo();
    const wm = new InMemoryWatermark();
    const usecase = new CollectAuthoredContent(gw, repo, wm, new InMemoryLedger(), () => "2026-05-05T00:00:00.000Z");

    const result = await usecase.run("Mantle_Official");

    expect(result.threadCount).toBe(1);
    expect(repo.saved[0].tweets.map((t) => t.id)).toEqual(["1", "2"]);
    expect(repo.saved[0].status).toBe("active");
    expect(repo.saved[0].firstSeenAt).toBe("2026-05-05T00:00:00.000Z");
    expect(wm.marks.get("Mantle_Official")).toBe("2026-01-01T00:02:00.000Z");
  });

  it("gap-fills via fetchThread when a thread root is missing from the batch", async () => {
    // Only a later reply (conversationId=100) is in the batch; root 100 is absent.
    const reply = tw("101", { conversationId: "100", isReply: true, createdAt: "2026-01-01T00:03:00.000Z" });
    const root = tw("100", { conversationId: "100", createdAt: "2026-01-01T00:00:30.000Z" });
    const gw = new FakeGateway([reply], { "100": [root, reply] });
    const repo = new InMemoryRepo();
    const usecase = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger(), () => "now");

    await usecase.run("Mantle_Official");

    expect(gw.threadCalls).toContain("100");
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0].tweets.map((t) => t.id).sort()).toEqual(["100", "101"]);
  });

  it("does not advance the watermark when nothing is fetched", async () => {
    const wm = new InMemoryWatermark();
    wm.marks.set("Mantle_Official", "2026-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(new FakeGateway([]), new InMemoryRepo(), wm, new InMemoryLedger(), () => "now");
    await usecase.run("Mantle_Official");
    expect(wm.marks.get("Mantle_Official")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("uses --since as the floor instead of the watermark and does not advance it", async () => {
    const gw = new FakeGateway([tw("1", { createdAt: "2026-01-01T00:05:00.000Z" })]);
    const wm = new InMemoryWatermark();
    wm.marks.set("Mantle_Official", "2020-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), wm, new InMemoryLedger(), () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official", { since: "2026-01-01T00:00:00.000Z" });

    expect(gw.lastSince).toBe("2026-01-01T00:00:00.000Z");
    expect(wm.marks.get("Mantle_Official")).toBe("2020-01-01T00:00:00.000Z"); // unchanged
  });

  it("records a coverage run to the ledger every run", async () => {
    const gw = new FakeGateway([
      tw("1", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("2", { conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" }),
    ]);
    const ledger = new InMemoryLedger();
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), ledger, () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official");

    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]).toMatchObject({
      target: "Mantle_Official",
      ranAt: "2026-05-05T00:00:00.000Z",
      covered: { from: "2026-01-01T00:01:00.000Z", to: "2026-01-01T00:02:00.000Z" },
      threadCount: 1,
      tweetCount: 2,
      truncated: false,
      gap: null,
    });
  });

  it("applies --limit keeping newest N threads and records a gap", async () => {
    const gw = new FakeGateway([
      tw("a", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("b", { createdAt: "2026-01-02T00:01:00.000Z" }),
      tw("c", { createdAt: "2026-01-03T00:01:00.000Z" }),
    ]);
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger();
    const usecase = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), ledger, () => "2026-05-05T00:00:00.000Z");

    const result = await usecase.run("Mantle_Official", { since: "2026-01-01T00:00:00.000Z", limit: 2 });

    expect(result.threadCount).toBe(2);
    expect(repo.saved.map((t) => t.rootId).sort()).toEqual(["b", "c"]);
    expect(ledger.runs[0].truncated).toBe(true);
    expect(ledger.runs[0].gap).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:01:00.000Z" });
  });

  it("records truncated + gap when the gateway exhausts MAX_PAGES", async () => {
    const gw = new FakeGateway([
      tw("a", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("b", { createdAt: "2026-01-02T00:01:00.000Z" }),
    ]);
    gw.exhausted = true;
    const ledger = new InMemoryLedger();
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), ledger, () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official", { since: "2026-01-01T00:00:00.000Z" });

    expect(ledger.runs[0].truncated).toBe(true);
    expect(ledger.runs[0].gap).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:01:00.000Z" });
  });

  it("does not advance the watermark for a limit-only run (no --since)", async () => {
    const gw = new FakeGateway([tw("1", { createdAt: "2026-01-01T00:05:00.000Z" })]);
    const wm = new InMemoryWatermark();
    wm.marks.set("Mantle_Official", "2020-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), wm, new InMemoryLedger(), () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official", { limit: 1 });

    expect(wm.marks.get("Mantle_Official")).toBe("2020-01-01T00:00:00.000Z"); // unchanged
  });

  it("fetches the body for an article tweet exactly once and stores the blocks", async () => {
    const gw = new FakeGateway([tw("1", { article: { title: "Phase 1: ClawHack" } }), tw("2")]);
    gw.articles["1"] = [{ type: "unstyled", text: "Body" }];
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["1"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
  });

  it("makes no article call when nothing is an article", async () => {
    const gw = new FakeGateway([tw("1"), tw("2")]);
    const uc = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual([]);
  });

  it("completes the collect when an article body fetch fails", async () => {
    const gw = new FakeGateway([tw("1", { article: { title: "T" } }), tw("2")]);
    gw.articleError = new Error("HTTP 500");
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    const result = await uc.run("Mantle_Official");

    expect(result.threadCount).toBe(2);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.title).toBe("T");
    expect(stored?.article?.blocks).toBeUndefined();
  });

  it("does not re-fetch an article body already present in the collection repository", async () => {
    const gw = new FakeGateway([tw("1", { article: { title: "Phase 1: ClawHack" } })]);
    const repo = new InMemoryRepo();
    repo.saved = [
      {
        rootId: "1",
        status: "active",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          tw("1", {
            article: { title: "Phase 1: ClawHack", blocks: [{ type: "unstyled", text: "Stored body" }] },
          }),
        ],
      },
    ];
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual([]); // already stored — no API call
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Stored body" }]);
  });

  it("fetches the body when an article carries an empty blocks array rather than treating it as already present", async () => {
    // t.article.blocks?.length, not t.article.blocks alone: an empty array is not a body. This
    // pins the guard at the "already has blocks" skip check.
    const gw = new FakeGateway([tw("1", { article: { title: "T", blocks: [] } })]);
    gw.articles["1"] = [{ type: "unstyled", text: "Body" }];
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["1"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
  });

  it("does not treat a stored article with an empty blocks array as an already-fetched body", async () => {
    // Same guard, at the storedBlocks skip-list built from the collection repository: a stored
    // blocks: [] must not permanently suppress the refetch.
    const gw = new FakeGateway([tw("1", { article: { title: "T" } })]);
    gw.articles["1"] = [{ type: "unstyled", text: "Fresh body" }];
    const repo = new InMemoryRepo();
    repo.saved = [
      {
        rootId: "1",
        status: "active",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [tw("1", { article: { title: "T", blocks: [] } })],
      },
    ];
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["1"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Fresh body" }]);
  });

  it("fetches the body for an article pulled in by thread gap-filling", async () => {
    // The root is absent from the authored page, so gapFillMissingRoots adds it — and it is
    // itself an article. This pins that the article pass runs after gap-filling, not before.
    const reply = tw("11", { conversationId: "10", isReply: true });
    const root = tw("10", { article: { title: "Root article" } });
    const gw = new FakeGateway([reply], { "10": [root] });
    gw.articles["10"] = [{ type: "unstyled", text: "Root body" }];
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["10"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "10");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Root body" }]);
  });
});
