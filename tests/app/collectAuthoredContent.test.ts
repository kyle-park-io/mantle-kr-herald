import { describe, it, expect } from "vitest";
import { CollectAuthoredContent } from "../../src/app/CollectAuthoredContent";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";
import type { CollectionRunLedger } from "../../src/ports/CollectionRunLedger";
import type { CollectionRun } from "../../src/domain/coverage";
import type { CollectedThread, SourceTweet } from "../../src/domain/models";

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
  };
}

class FakeGateway implements SourceGateway {
  public threadCalls: string[] = [];
  public lastSince: string | undefined;
  constructor(
    private readonly authored: SourceTweet[],
    private readonly threads: Record<string, SourceTweet[]> = {},
  ) {}
  async *fetchAuthoredTweets(_userName: string, sinceTime?: string): AsyncGenerator<SourceTweet> {
    this.lastSince = sinceTime;
    for (const t of this.authored) yield t;
  }
  async fetchThread(id: string): Promise<SourceTweet[]> {
    this.threadCalls.push(id);
    return this.threads[id] ?? [];
  }
  async fetchByIds(): Promise<SourceTweet[]> {
    return [];
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
});
