import { describe, it, expect } from "vitest";
import { BackfillTextVideoUrls } from "../../src/app/BackfillTextVideoUrls";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { CollectedThread, MediaItem, SourceTweet } from "../../src/domain/models";
import type { Translation } from "../../src/domain/translation/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import { renderingKey } from "../../src/ports/FormattingStore";

const MP4_A = "https://video.twimg.com/amplify_video/1/vid/avc1/720x720/a.mp4?tag=14";
const MP4_B = "https://video.twimg.com/amplify_video/2/vid/avc1/720x720/b.mp4?tag=14";

const photo = (url: string): MediaItem => ({ type: "photo", url });
const video = (url: string, videoUrl?: string): MediaItem => ({
  type: "video",
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
  return { rootId, tweets, status: "active", firstSeenAt: "2026-06-01T00:00:00.000Z", ...extra };
}

function translation(itemId: string, texts: Partial<Translation> = {}): Translation {
  return {
    itemId,
    source: "x",
    sourceText: "",
    koreanText: "",
    status: "posted",
    translatedAt: "2026-06-02T00:00:00.000Z",
    ...texts,
  };
}

function rendering(itemId: string, text: string, extra: Partial<ChannelRendering> = {}): ChannelRendering {
  return {
    itemId,
    type: "x",
    channel: "x",
    text,
    refined: false,
    createdAt: "2026-06-03T00:00:00.000Z",
    status: "rendered",
    ...extra,
  };
}

class FakeThreads implements CollectionRepository {
  constructor(private readonly threads: CollectedThread[]) {}
  async loadAll(): Promise<CollectedThread[]> {
    return this.threads;
  }
  async upsert(): Promise<void> {
    throw new Error("this command never writes x_threads");
  }
  async listActiveTweetIds(): Promise<string[]> {
    return [];
  }
  async markDeleted(): Promise<void> {}
}

class FakeTranslations implements TranslationStore {
  public writes: Translation[] = [];
  constructor(private rows: Translation[]) {}
  async loadAll(): Promise<Translation[]> {
    // Deep copies, so a use case that mutated a row in place instead of writing a patch would fail
    // the next `loadAll` rather than quietly look idempotent.
    return this.rows.map((r) => structuredClone(r));
  }
  async upsert(t: Translation): Promise<void> {
    this.writes.push(t);
    this.rows = this.rows.map((r) => (r.itemId === t.itemId ? t : r));
  }
  async listTranslatedIds(): Promise<Set<string>> {
    return new Set(this.rows.map((r) => r.itemId));
  }
}

class FakeRenderings implements FormattingStore {
  public writes: ChannelRendering[] = [];
  constructor(private rows: ChannelRendering[]) {}
  async loadAll(): Promise<ChannelRendering[]> {
    return this.rows.map((r) => structuredClone(r));
  }
  async upsert(r: ChannelRendering): Promise<void> {
    this.writes.push(r);
    this.rows = this.rows.map((row) => (renderingKey(row) === renderingKey(r) ? r : row));
  }
  async listRenderedKeys(): Promise<Set<string>> {
    return new Set(this.rows.map(renderingKey));
  }
}

function usecaseOver(threads: CollectedThread[], translations: FakeTranslations, renderings: FakeRenderings) {
  return new BackfillTextVideoUrls(new FakeThreads(threads), translations, renderings);
}

describe("BackfillTextVideoUrls", () => {
  it("fills the bare marker in both of a translation's stored texts, from the collected thread", async () => {
    const threads = [thread("1", [tweet("1", [video("poster.jpg", MP4_A)])])];
    const tr = new FakeTranslations([
      translation("x:1", { sourceText: "text 1\n\n[영상]", koreanText: "1번 글\n\n[영상]" }),
    ]);
    const re = new FakeRenderings([]);
    const usecase = usecaseOver(threads, tr, re);

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan.filled).toBe(2);
    expect(plan.translations).toHaveLength(1);
    expect(plan.translations[0].columns).toEqual(["source_text", "korean_text"]);
    expect(plan.skipped).toEqual([]);
    expect(tr.writes).toHaveLength(1);
    expect(tr.writes[0].sourceText).toBe(`text 1\n\n[영상] ${MP4_A}`);
    expect(tr.writes[0].koreanText).toBe(`1번 글\n\n[영상] ${MP4_A}`);
    expect(written).toEqual({ translations: 1, renderings: 0 });
  });

  it("never writes published_text, even when it carries a bare marker of its own", async () => {
    // `published_text` is the record of what the account actually posted. Rewriting it would make
    // the 1차 검수 diff show an edit the human never made, and there is no other copy of that text.
    const threads = [thread("2", [tweet("2", [video("poster.jpg", MP4_A)])])];
    const publishedText = "사람이 실제로 올린 글\n\n[영상]";
    const stored = translation("x:2", {
      sourceText: "text 2\n\n[영상]",
      koreanText: "2번 글\n\n[영상]",
      publishedText,
      status: "posted",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-07-05T00:00:00.000Z",
      approvedAt: "2026-07-04T00:00:00.000Z",
    });
    const tr = new FakeTranslations([stored]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    await usecase.apply(plan);

    // The whole write, not just `published_text`: every column but the two texts comes back holding
    // the value it already had, which is what makes this command's write surface exactly its three
    // columns rather than "whatever the upsert happens to carry".
    expect(tr.writes[0]).toEqual({
      ...stored,
      sourceText: `text 2\n\n[영상] ${MP4_A}`,
      koreanText: `2번 글\n\n[영상] ${MP4_A}`,
    });
    expect(tr.writes[0].publishedText).toBe(publishedText);
    // Not merely left alone on the write — it is not a target, so it never becomes a countable
    // text either. A bare marker in it is not a skip to report, it is none of this command's
    // business.
    expect(plan.scanned).toBe(2);
    expect(plan.skipped).toEqual([]);
  });

  it("fills a rendering's text and leaves everything else on the row alone", async () => {
    const threads = [thread("3", [tweet("3", [video("poster.jpg", MP4_A)])])];
    const stored = rendering("x:3", "렌더링 본문\n\n[영상]", { refined: true, status: "approved", approvedAt: "2026-06-04T00:00:00.000Z" });
    const re = new FakeRenderings([stored]);
    const usecase = usecaseOver(threads, new FakeTranslations([]), re);

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan.renderings).toHaveLength(1);
    expect(re.writes[0]).toEqual({ ...stored, text: `렌더링 본문\n\n[영상] ${MP4_A}` });
    expect(written).toEqual({ translations: 0, renderings: 1 });
  });

  it("takes the videos in thread order across tweets, skipping the nested replies that never became markers", async () => {
    // The marker sequence in the stored text was written by `flattenXThreads`, which drops a nested
    // commenter reply whole. Reading media straight off `thread.tweets` would count that reply's
    // video and shift every pairing after it by one.
    const threads = [
      thread("4", [
        tweet("4", [video("first.jpg", MP4_A)]),
        tweet("5", [video("noise.jpg", "https://video/should-never-be-used.mp4")], {
          conversationId: "4",
          isReply: true,
          text: "@someone 💚",
        }),
        tweet("6", [video("second.jpg", MP4_B)], { conversationId: "4", isReply: true }),
      ]),
    ];
    const tr = new FakeTranslations([
      translation("x:4", { sourceText: "text 4\n\n[영상]\n\n---\n\ntext 6\n\n[영상]", koreanText: "" }),
    ]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    await usecase.apply(await usecase.plan());

    expect(tr.writes[0].sourceText).toBe(`text 4\n\n[영상] ${MP4_A}\n\n---\n\ntext 6\n\n[영상] ${MP4_B}`);
  });

  it("still fills a translation whose thread has since been marked deleted", async () => {
    // A deleted thread's translation is still on the review screens, so its clip is still worth
    // having. `flattenXThreads` would drop the thread from the queue — that is a different question.
    const threads = [
      thread("5", [tweet("5", [video("p.jpg", MP4_A)])], { status: "deleted", deletedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    const tr = new FakeTranslations([translation("x:5", { sourceText: "text 5\n\n[영상]", koreanText: "" })]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(plan.skipped).toEqual([]);
    expect(tr.writes[0].sourceText).toBe(`text 5\n\n[영상] ${MP4_A}`);
  });

  it("skips a text whose markers do not line up with the thread's videos, and names it", async () => {
    const threads = [thread("6", [tweet("6", [video("p.jpg", MP4_A)])])];
    const tr = new FakeTranslations([
      // Two markers, one video: nothing says which clip the second one is.
      translation("x:6", { sourceText: "text 6\n\n[영상]\n[영상]", koreanText: "6번 글\n\n[영상]" }),
    ]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(plan.skipped).toEqual([
      { itemId: "x:6", column: "translations.source_text", bare: 2, reason: { kind: "count-mismatch", markers: 2, videos: 1 } },
    ]);
    // The other column of the same row is unambiguous, so it is still filled — the refusal is per
    // text, not per row.
    expect(plan.translations[0].columns).toEqual(["korean_text"]);
    expect(tr.writes[0].sourceText).toBe("text 6\n\n[영상]\n[영상]");
    expect(tr.writes[0].koreanText).toBe(`6번 글\n\n[영상] ${MP4_A}`);
  });

  it("skips a text whose thread video still has no mp4 at all, and says so separately", async () => {
    // `x:video-backfill` has not reached this thread yet. Different remedy from a count mismatch,
    // so it is a different reason rather than one blanket \"could not fill\".
    const threads = [thread("7", [tweet("7", [video("p.jpg")])])];
    const tr = new FakeTranslations([translation("x:7", { sourceText: "text 7\n\n[영상]", koreanText: "" })]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan.skipped).toEqual([
      { itemId: "x:7", column: "translations.source_text", bare: 1, reason: { kind: "url-missing", missing: 1 } },
    ]);
    expect(plan.filled).toBe(0);
    expect(tr.writes).toEqual([]);
    expect(written).toEqual({ translations: 0, renderings: 0 });
  });

  it("skips a text with no collected thread behind it, and names it too", async () => {
    const tr = new FakeTranslations([
      { ...translation("lark:abc", { sourceText: "라크 글\n\n[영상]", koreanText: "" }), source: "lark" },
      translation("x:missing", { sourceText: "사라진 스레드\n\n[영상]", koreanText: "" }),
    ]);
    const usecase = usecaseOver([], tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    await usecase.apply(plan);

    expect(plan.skipped).toEqual([
      { itemId: "lark:abc", column: "translations.source_text", bare: 1, reason: { kind: "no-thread" } },
      { itemId: "x:missing", column: "translations.source_text", bare: 1, reason: { kind: "no-thread" } },
    ]);
    expect(tr.writes).toEqual([]);
  });

  it("reports a skipped rendering with the (type, channel) that identifies its row", async () => {
    const threads = [thread("8", [tweet("8", [video("p.jpg", MP4_A)])])];
    const re = new FakeRenderings([
      rendering("x:8", "본문\n\n[영상]\n[영상]", { type: "announcement", channel: "telegram" }),
    ]);
    const usecase = usecaseOver(threads, new FakeTranslations([]), re);

    const plan = await usecase.plan();

    expect(plan.skipped).toEqual([
      {
        itemId: "x:8",
        column: "renderings.text",
        type: "announcement",
        channel: "telegram",
        bare: 2,
        reason: { kind: "count-mismatch", markers: 2, videos: 1 },
      },
    ]);
  });

  it("leaves a photo-only text and an already-filled marker out of the plan entirely", async () => {
    const threads = [
      thread("9", [tweet("9", [photo("a.jpg")])]),
      thread("10", [tweet("10", [video("p.jpg", MP4_A)])]),
    ];
    const tr = new FakeTranslations([
      translation("x:9", { sourceText: "text 9\n\n[사진](a.jpg)", koreanText: "9번 글\n\n![](a.jpg)" }),
      translation("x:10", { sourceText: `text 10\n\n[영상] ${MP4_A}`, koreanText: `10번 글\n\n[영상] ${MP4_A}` }),
    ]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();
    const written = await usecase.apply(plan);

    expect(plan).toMatchObject({ scanned: 0, filled: 0, translations: [], renderings: [], skipped: [] });
    expect(tr.writes).toEqual([]);
    expect(written).toEqual({ translations: 0, renderings: 0 });
  });

  it("writes only the rows that actually change", async () => {
    const threads = [
      thread("11", [tweet("11", [video("p.jpg", MP4_A)])]),
      thread("12", [tweet("12", [video("p.jpg", MP4_B)])]),
    ];
    const tr = new FakeTranslations([
      translation("x:11", { sourceText: `text 11\n\n[영상] ${MP4_A}`, koreanText: `11번 글\n\n[영상] ${MP4_A}` }),
      translation("x:12", { sourceText: "text 12\n\n[영상]", koreanText: `12번 글\n\n[영상] ${MP4_B}` }),
    ]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    await usecase.apply(await usecase.plan());

    expect(tr.writes.map((t) => t.itemId)).toEqual(["x:12"]);
  });

  it("is idempotent: a second run finds nothing and writes nothing", async () => {
    const threads = [thread("13", [tweet("13", [video("p.jpg", MP4_A)])])];
    const tr = new FakeTranslations([
      translation("x:13", { sourceText: "text 13\n\n[영상]", koreanText: "13번 글\n\n[영상]" }),
    ]);
    const re = new FakeRenderings([rendering("x:13", "렌더링\n\n[영상]")]);
    const usecase = usecaseOver(threads, tr, re);

    await usecase.apply(await usecase.plan());
    const second = await usecase.plan();
    const written = await usecase.apply(second);

    expect(second).toMatchObject({ scanned: 0, filled: 0, translations: [], renderings: [], skipped: [] });
    expect(tr.writes).toHaveLength(1);
    expect(re.writes).toHaveLength(1);
    expect(written).toEqual({ translations: 0, renderings: 0 });
  });

  it("counts every text carrying a bare marker as scanned, filled or not", async () => {
    const threads = [
      thread("14", [tweet("14", [video("p.jpg", MP4_A)])]),
      thread("15", [tweet("15", [video("p.jpg")])]),
    ];
    const tr = new FakeTranslations([
      translation("x:14", { sourceText: "text 14\n\n[영상]", koreanText: "14번 글\n\n[영상]" }),
      translation("x:15", { sourceText: "text 15\n\n[영상]", koreanText: "" }),
    ]);
    const usecase = usecaseOver(threads, tr, new FakeRenderings([]));

    const plan = await usecase.plan();

    expect(plan.scanned).toBe(3);
    expect(plan.filled).toBe(2);
    expect(plan.skipped).toHaveLength(1);
  });
});
