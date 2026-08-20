import { describe, it, expect } from "vitest";
import { BackfillVideoUrls } from "../../src/app/BackfillVideoUrls";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { CollectedThread, MediaItem, SourceTweet, UserProfile } from "../../src/domain/models";

const photo = (url: string): MediaItem => ({ type: "photo", url });
const video = (url: string, videoUrl?: string): MediaItem => ({
  type: "video",
  url,
  ...(videoUrl ? { videoUrl } : {}),
});
const gif = (url: string, videoUrl?: string): MediaItem => ({
  type: "animated_gif",
  url,
  ...(videoUrl ? { videoUrl } : {}),
});

function tweet(id: string, media?: MediaItem[], extra: Partial<SourceTweet> = {}): SourceTweet {
  return {
    id,
    conversationId: id,
    text: `text ${id}`,
    createdAt: "2026-05-31T00:00:00.000Z",
    url: `https://x.com/Mantle_Official/status/${id}`,
    authorUserName: "Mantle_Official",
    isReply: false,
    isQuote: false,
    ...(media ? { media } : {}),
    ...extra,
  };
}

function thread(rootId: string, tweets: SourceTweet[], extra: Partial<CollectedThread> = {}): CollectedThread {
  return {
    rootId,
    tweets,
    status: "active",
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    ...extra,
  };
}

class FakeGateway implements SourceGateway {
  public batches: string[][] = [];
  /** Keyed by tweet id; an id absent from the map is one the endpoint does not return at all. */
  constructor(private readonly live: Map<string, SourceTweet>) {}
  async *fetchAuthoredTweets(): AsyncGenerator<SourceTweet, boolean> {
    return false;
  }
  async fetchThread(): Promise<SourceTweet[]> {
    return [];
  }
  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    this.batches.push(ids);
    return ids.map((id) => this.live.get(id)).filter((t): t is SourceTweet => t !== undefined);
  }
  async fetchArticle(): Promise<undefined> {
    return undefined;
  }
  async fetchUserProfile(): Promise<UserProfile> {
    return { userName: "stub" };
  }
}

class FakeRepo implements CollectionRepository {
  public writes: CollectedThread[][] = [];
  constructor(private threads: CollectedThread[]) {}
  async loadAll(): Promise<CollectedThread[]> {
    return this.threads;
  }
  async upsert(threads: CollectedThread[]): Promise<void> {
    this.writes.push(threads);
    // Mirrors PgCollectionRepository's "incoming wins, merged by rootId" enough for the
    // idempotence test: a second plan() must read back what the first apply() wrote.
    this.threads = this.threads.map((existing) => threads.find((t) => t.rootId === existing.rootId) ?? existing);
  }
  async listActiveTweetIds(): Promise<string[]> {
    return this.threads.flatMap((t) => t.tweets.map((tw) => tw.id));
  }
  async markDeleted(): Promise<void> {}
}

describe("BackfillVideoUrls", () => {
  it("counts a video/animated_gif media entry with no videoUrl as a candidate, whatever the thread's status", async () => {
    const repo = new FakeRepo([
      thread("1", [tweet("1", [photo("p1.jpg"), video("v1.jpg")])]),
      thread("2", [tweet("2", [video("v2.jpg", "v2.mp4")])]), // already filled — not a candidate
      thread("3", [tweet("3", [photo("p3.jpg")])]), // photos never are
      // A deleted thread's stored text is still read by the review screens, so its media counts too.
      thread("4", [tweet("4", [gif("g4.jpg")])], { status: "deleted", deletedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const gw = new FakeGateway(new Map());

    const plan = await new BackfillVideoUrls(gw, repo).plan();

    expect(plan.candidates).toBe(2);
    expect(plan.candidateThreads).toBe(2);
    expect(plan.candidateTweetIds).toEqual(["1", "4"]);
    expect(gw.batches).toEqual([["1", "4"]]);
  });

  it("makes no API call and no write when there is nothing to fill", async () => {
    const repo = new FakeRepo([
      thread("1", [tweet("1", [photo("p1.jpg")])]),
      thread("2", [tweet("2", [video("v2.jpg", "v2.mp4")])]),
    ]);
    const gw = new FakeGateway(new Map());
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan.candidates).toBe(0);
    expect(plan.patched).toEqual([]);
    expect(gw.batches).toEqual([]);
    expect(repo.writes).toEqual([]);
    expect(written).toBe(0);
  });

  it("patches only videoUrl and hands back everything else byte-identical", async () => {
    const stored = thread(
      "100",
      [
        tweet("100", [photo("cover.jpg")], {
          article: { title: "A", previewText: "p", blocks: [{ type: "unstyled", text: "body" }] },
          metrics: { likeCount: 7, viewCount: 900 },
        }),
        tweet("101", [photo("still.jpg"), video("poster.jpg")], {
          conversationId: "100",
          isReply: true,
          createdAt: "2026-05-31T00:05:00.000Z",
        }),
      ],
      { status: "deleted", firstSeenAt: "2026-06-02T03:04:05.000Z", deletedAt: "2026-07-09T00:00:00.000Z" },
    );
    const before = JSON.stringify(stored);
    const repo = new FakeRepo([stored]);
    const gw = new FakeGateway(new Map([["101", tweet("101", [video("poster.jpg", "poster-1280.mp4")])]]));
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    await usecase.apply(plan);

    // Byte-identical, not merely deep-equal: `x_threads.tweets` is a `json` column (not `jsonb`)
    // precisely so `db:export` reproduces the original bytes, so a reordered key is a real
    // regression here — see PgCollectionRepository's class comment.
    const expected = JSON.parse(before) as CollectedThread;
    expected.tweets[1].media![1].videoUrl = "poster-1280.mp4";
    expect(JSON.stringify(repo.writes[0][0])).toBe(JSON.stringify(expected));
    // The stored thread it was handed is never mutated in place — the write is the only change.
    expect(JSON.stringify(stored)).toBe(before);
    expect(plan.filled).toBe(1);
    expect(plan.unfilledTweetIds).toEqual([]);
  });

  it("matches a media entry by its thumbnail url, not by array position", async () => {
    const stored = thread("200", [tweet("200", [video("first.jpg"), video("second.jpg")])]);
    const repo = new FakeRepo([stored]);
    // Same two videos, returned in the opposite order: position-matching would swap the mp4s.
    const gw = new FakeGateway(
      new Map([["200", tweet("200", [video("second.jpg", "second.mp4"), video("first.jpg", "first.mp4")])]]),
    );
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(repo.writes[0][0].tweets[0].media).toEqual([
      { type: "video", url: "first.jpg", videoUrl: "first.mp4" },
      { type: "video", url: "second.jpg", videoUrl: "second.mp4" },
    ]);
    expect(plan.candidates).toBe(2);
    expect(plan.filled).toBe(2);
  });

  it("is idempotent: a second run finds no candidates and writes nothing", async () => {
    const repo = new FakeRepo([thread("300", [tweet("300", [video("p.jpg")])])]);
    const gw = new FakeGateway(new Map([["300", tweet("300", [video("p.jpg", "p.mp4")])]]));
    const usecase = new BackfillVideoUrls(gw, repo);

    await usecase.apply(await usecase.plan());
    const second = await usecase.plan();
    const written = await usecase.apply(second);

    expect(second.candidates).toBe(0);
    expect(gw.batches).toHaveLength(1); // the second plan never reached the API
    expect(repo.writes).toHaveLength(1);
    expect(written).toBe(0);
  });

  it("leaves a candidate the API returns without an mp4 as a candidate, and reports it unfilled", async () => {
    const repo = new FakeRepo([thread("400", [tweet("400", [video("p.jpg")])])]);
    // Returned, alive, still no video_info that carried a usable mp4.
    const gw = new FakeGateway(new Map([["400", tweet("400", [video("p.jpg")])]]));
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan.candidates).toBe(1);
    expect(plan.filled).toBe(0);
    expect(plan.unfilledTweetIds).toEqual(["400"]);
    expect(plan.patched).toEqual([]);
    expect(repo.writes).toEqual([]);
    expect(written).toBe(0);
  });

  it("does not throw when a batch comes back missing some ids — they are reported unfilled", async () => {
    const repo = new FakeRepo([
      thread("500", [tweet("500", [video("a.jpg")])]),
      thread("501", [tweet("501", [video("b.jpg")])]),
    ]);
    const gw = new FakeGateway(new Map([["501", tweet("501", [video("b.jpg", "b.mp4")])]]));
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(plan.unfilledTweetIds).toEqual(["500"]);
    expect(plan.filled).toBe(1);
    // Only the thread that actually changed is written.
    expect(repo.writes).toHaveLength(1);
    expect(repo.writes[0].map((t) => t.rootId)).toEqual(["501"]);
  });

  it("asks for candidate ids in batches of batchSize", async () => {
    const repo = new FakeRepo([
      thread("600", [tweet("600", [video("a.jpg")]), tweet("601", [video("b.jpg")])]),
      thread("602", [tweet("602", [video("c.jpg")])]),
    ]);
    const gw = new FakeGateway(new Map());

    await new BackfillVideoUrls(gw, repo, 2).plan();

    expect(gw.batches).toEqual([["600", "601"], ["602"]]);
  });

  it("reports one unfilled id for a tweet whose second video the API could not fill", async () => {
    const repo = new FakeRepo([thread("700", [tweet("700", [video("a.jpg"), video("b.jpg")])])]);
    const gw = new FakeGateway(new Map([["700", tweet("700", [video("a.jpg", "a.mp4")])]]));
    const usecase = new BackfillVideoUrls(gw, repo);

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(plan.candidates).toBe(2);
    expect(plan.filled).toBe(1);
    expect(plan.unfilledTweetIds).toEqual(["700"]);
    expect(repo.writes[0][0].tweets[0].media).toEqual([
      { type: "video", url: "a.jpg", videoUrl: "a.mp4" },
      { type: "video", url: "b.jpg" },
    ]);
  });
});
