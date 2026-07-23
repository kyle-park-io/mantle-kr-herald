import { describe, it, expect } from "vitest";
import { ReconcileDeletions } from "../../src/app/ReconcileDeletions";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { SourceTweet } from "../../src/domain/models";

function tw(id: string): SourceTweet {
  return {
    id,
    conversationId: id,
    text: `t${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: `u/${id}`,
    authorUserName: "Mantle_Official",
    isReply: false,
    isQuote: false,
  };
}

class FakeGateway implements SourceGateway {
  public batches: string[][] = [];
  constructor(private readonly alive: Set<string>) {}
  async *fetchAuthoredTweets(): AsyncGenerator<SourceTweet, boolean> {
    return false;
  }
  async fetchThread(): Promise<SourceTweet[]> {
    return [];
  }
  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    this.batches.push(ids);
    return ids.filter((id) => this.alive.has(id)).map(tw);
  }
  async fetchArticle(): Promise<[]> {
    return [];
  }
}

class RecordingRepo implements CollectionRepository {
  public deleted: { ids: string[]; at: string } | undefined;
  constructor(private readonly activeIds: string[]) {}
  async loadAll() {
    return [];
  }
  async upsert() {}
  async listActiveTweetIds() {
    return this.activeIds;
  }
  async markDeleted(tweetIds: string[], deletedAt: string) {
    this.deleted = { ids: tweetIds, at: deletedAt };
  }
}

describe("ReconcileDeletions", () => {
  it("marks ids that are no longer alive as deleted", async () => {
    const gw = new FakeGateway(new Set(["1", "3"])); // "2" was deleted upstream
    const repo = new RecordingRepo(["1", "2", "3"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "2026-06-06T00:00:00.000Z");

    const result = await usecase.run();

    expect(result).toEqual({ checked: 3, deleted: 1 });
    expect(repo.deleted).toEqual({ ids: ["2"], at: "2026-06-06T00:00:00.000Z" });
  });

  it("does not call markDeleted when nothing is missing (idempotent)", async () => {
    const gw = new FakeGateway(new Set(["1", "2"]));
    const repo = new RecordingRepo(["1", "2"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "now");
    const result = await usecase.run();
    expect(result.deleted).toBe(0);
    expect(repo.deleted).toBeUndefined();
  });

  it("checks ids in batches of batchSize", async () => {
    const gw = new FakeGateway(new Set(["1", "2", "3"]));
    const repo = new RecordingRepo(["1", "2", "3"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "now", 2);
    await usecase.run();
    expect(gw.batches).toEqual([["1", "2"], ["3"]]);
  });
});
