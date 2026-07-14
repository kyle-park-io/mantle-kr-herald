import { describe, it, expect } from "vitest";
import { CollectAuthoredContent } from "../../src/app/CollectAuthoredContent";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { WatermarkStore } from "../../src/ports/WatermarkStore";
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
  constructor(
    private readonly authored: SourceTweet[],
    private readonly threads: Record<string, SourceTweet[]> = {},
  ) {}
  async *fetchAuthoredTweets(): AsyncGenerator<SourceTweet> {
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
  constructor(public value?: string) {}
  async get() {
    return this.value;
  }
  async set(time: string) {
    this.value = time;
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
    const usecase = new CollectAuthoredContent(gw, repo, wm, () => "2026-05-05T00:00:00.000Z");

    const result = await usecase.run("Mantle_Official");

    expect(result.threadCount).toBe(1);
    expect(repo.saved[0].tweets.map((t) => t.id)).toEqual(["1", "2"]);
    expect(repo.saved[0].status).toBe("active");
    expect(repo.saved[0].firstSeenAt).toBe("2026-05-05T00:00:00.000Z");
    expect(wm.value).toBe("2026-01-01T00:02:00.000Z");
  });

  it("gap-fills via fetchThread when a thread root is missing from the batch", async () => {
    // Only a later reply (conversationId=100) is in the batch; root 100 is absent.
    const reply = tw("101", { conversationId: "100", isReply: true, createdAt: "2026-01-01T00:03:00.000Z" });
    const root = tw("100", { conversationId: "100", createdAt: "2026-01-01T00:00:30.000Z" });
    const gw = new FakeGateway([reply], { "100": [root, reply] });
    const repo = new InMemoryRepo();
    const usecase = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), () => "now");

    await usecase.run("Mantle_Official");

    expect(gw.threadCalls).toContain("100");
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0].tweets.map((t) => t.id).sort()).toEqual(["100", "101"]);
  });

  it("does not advance the watermark when nothing is fetched", async () => {
    const wm = new InMemoryWatermark("2026-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(new FakeGateway([]), new InMemoryRepo(), wm, () => "now");
    await usecase.run("Mantle_Official");
    expect(wm.value).toBe("2026-01-01T00:00:00.000Z");
  });
});
