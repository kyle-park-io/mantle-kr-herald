import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XContentSource, flattenXThreads, xThreadIntake } from "../../../src/adapters/content/XContentSource";
import { extractMedia, stripMedia } from "../../../src/domain/media/sourceMedia";
import type { CollectedThread, SourceTweet } from "../../../src/domain/models";

const MP4 = "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/720x720/hi.mp4?tag=14";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "xsrc-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function writeThreads(threads: unknown): Promise<string> {
  const p = join(dir, "items.json");
  return writeFile(p, JSON.stringify(threads), "utf8").then(() => p);
}
const tweet = (o: Record<string, unknown>) => ({
  id: "100", conversationId: "100", text: "t", createdAt: "2026-07-28T00:00:00Z",
  url: "https://x.com/a/status/100", authorUserName: "a", isReply: false, isQuote: false, ...o,
});

describe("XContentSource isReply", () => {
  it("carries the root tweet's isReply and url onto the ContentItem", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [tweet({ isReply: true })] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.isReply).toBe(true);
    expect(item.refUrl).toBe("https://x.com/a/status/100");
  });
  it("is false for a non-reply root", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [tweet({ isReply: false })] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.isReply).toBe(false);
  });

  /**
   * The author is what decides whether the translate floor applies to this item
   * (`PrepareTranslations.applySelector`, and `src/domain/sweptAccount.ts` for why the handle is the
   * marker). Dropping it here is not a cosmetic loss: an item with no author is treated as the swept
   * account's, so a hand-picked post from another account would be filtered out below the floor —
   * silently, which is the whole failure mode 링크 수집's door gate exists to end.
   */
  it("carries the root tweet's author onto the ContentItem", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [
      tweet({ id: "100", authorUserName: "someone_else" }),
      tweet({ id: "101", authorUserName: "quoted_person" }),
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.author).toBe("someone_else");
  });

  it("drops a nested commenter-reply entirely, keeping the root and self-continuations", async () => {
    // These used to be kept and prefixed "(댓글 · 지워도 됨)" — an instruction to the translator to
    // delete them by hand, on every worksheet, forever. Measured against production 2026-08-07:
    // 140 such blocks across 46 threads. A block nobody ever wants translated does not belong in
    // the 원문 at all.
    //
    // A self-continuation is `isReply` too but does NOT lead with "@", which is what separates
    // "Mantle continuing its own thread" from "Mantle answering someone" — that distinction is the
    // whole reason this filter can be safe.
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [
      tweet({ id: "100", text: "24/7 access to markets" }),                  // root, isReply false
      tweet({ id: "101", text: "Come Saturday, trade here", isReply: true }), // self-continuation, no @
      tweet({ id: "102", text: "@churchi 🫡", isReply: true }),                // commenter-reply
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe("24/7 access to markets\n\n---\n\nCome Saturday, trade here");
  });

  it("drops a reply-only thread entirely — no item is produced", async () => {
    // 92 of production's 221 collected threads are this shape (42%), each arriving in 1차 검수 as
    // its own row for a human to skip: "@elfa_ai 🥳🥳", "@Agnidex 💚". They are Mantle answering
    // someone on X, never Korean announcement copy.
    const path = await writeThreads([{ rootId: "200", status: "active", tweets: [
      tweet({ id: "200", text: "@someone thanks", isReply: true }),
    ] }]);
    expect(await new XContentSource(path).loadPending(new Set())).toEqual([]);
  });

  it("keeps a thread whose root merely starts with @ but is not a reply", async () => {
    // A genuine post can open with a mention ("@Fluxion_network is now live on Mantle."). Only the
    // combination of isReply AND a leading @ means "answering someone" — either alone does not.
    const path = await writeThreads([{ rootId: "300", status: "active", tweets: [
      tweet({ id: "300", text: "@Fluxion_network is now live on Mantle.", isReply: false }),
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe("@Fluxion_network is now live on Mantle.");
  });

  it("keeps a self-continuation thread whose root is a reply without a leading @", async () => {
    // Rare but real: a root that is flagged isReply while continuing Mantle's own thought. It is
    // not "answering someone", so it must survive — this is the case a lazier `isReply`-only
    // filter would silently delete.
    const path = await writeThreads([{ rootId: "400", status: "active", tweets: [
      tweet({ id: "400", text: "Continuing the thread above.", isReply: true }),
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe("Continuing the thread above.");
  });
});

describe("xThreadIntake", () => {
  // Typed, unlike the `tweet` helper above: these threads are handed straight to a function rather
  // than written out as JSON, so the compiler can hold them to `SourceTweet`.
  const t = (o: Partial<SourceTweet> = {}): SourceTweet => ({
    id: "1", conversationId: "1", text: "24/7 access to markets", createdAt: "2026-08-01T00:00:00Z",
    url: "https://x.com/Mantle_Official/status/1", authorUserName: "Mantle_Official",
    isReply: false, isQuote: false, ...o,
  });
  const thread = (
    status: CollectedThread["status"],
    ...tweets: SourceTweet[]
  ): Pick<CollectedThread, "rootId" | "tweets" | "status"> => ({ rootId: tweets[0]?.id ?? "0", tweets, status });

  it("counts the threads collection handed the pipeline and the ones the reply filter dropped", () => {
    const intake = xThreadIntake([
      thread("active", t({ id: "1" })),
      thread("active", t({ id: "2", text: "@elfa_ai 🥳🥳", isReply: true })),
      thread("active", t({ id: "3", text: "@Agnidex 💚", isReply: true })),
    ]);
    expect(intake).toEqual({ threads: 3, repliesDropped: 2 });
  });

  it("ignores deleted threads, which no rule dropped — they never enter the funnel at all", () => {
    // Counting them would put a number in front of the Collected total that nothing downstream
    // could ever produce, which is the misreading this line exists to end rather than restart.
    const intake = xThreadIntake([
      thread("active", t({ id: "1" })),
      thread("deleted", t({ id: "2" })),
      thread("deleted", t({ id: "3", text: "@someone thanks", isReply: true })),
    ]);
    expect(intake).toEqual({ threads: 1, repliesDropped: 0 });
  });

  it("drops on the FIRST tweet only — a nested commenter reply still leaves an item", () => {
    // `flattenXThreads` removes a nested reply from the 원문 but keeps the thread. Counting it as a
    // dropped thread would report a toll the pipeline never took.
    const intake = xThreadIntake([
      thread("active", t({ id: "1" }), t({ id: "2", text: "@churchi 🫡", isReply: true })),
    ]);
    expect(intake).toEqual({ threads: 1, repliesDropped: 0 });
  });

  it("counts a thread with no tweets at all as considered and not dropped", () => {
    // `flattenXThreads` still emits an item for it (with `createdAt: ""`), so the funnel has to too.
    expect(xThreadIntake([thread("active")])).toEqual({ threads: 1, repliesDropped: 0 });
  });

  it("is all zeros with nothing collected", () => {
    expect(xThreadIntake([])).toEqual({ threads: 0, repliesDropped: 0 });
  });

  it("agrees with flattenXThreads over the same rows: threads - repliesDropped is the item count", () => {
    // The invariant the whole line rests on. `pnpm status` prints `threads - dropped` as the X half
    // of its total, so if this identity ever broke the funnel would report a number no code path
    // agrees with — which is exactly why the predicate is shared rather than copied.
    const threads = [
      thread("active", t({ id: "1" })),                                         // ordinary post
      thread("active", t({ id: "2", text: "@elfa_ai 🥳🥳", isReply: true })),    // dropped whole
      thread("active", t({ id: "3", text: "@Fluxion_network is now live on Mantle.", isReply: false })), // kept: not a reply
      thread("active", t({ id: "4", text: "Continuing the thread above.", isReply: true })),             // kept: no leading @
      thread("active", t({ id: "5" }), t({ id: "6", text: "@churchi 🫡", isReply: true })),               // kept, nested reply removed
      thread("deleted", t({ id: "7" })),                                        // not in the funnel
      thread("active"),                                                         // no tweets
    ];
    const intake = xThreadIntake(threads);
    expect(intake).toEqual({ threads: 6, repliesDropped: 1 });
    // The set is empty because that is what `pnpm status` passes: it asks for everything collected,
    // not for what is still untranslated.
    expect(intake.threads - intake.repliesDropped).toBe(flattenXThreads(threads, new Set()).length);
  });
});

describe("XContentSource media markers", () => {
  it("surfaces a post's photo as a labelled [사진] marker after the text", async () => {
    const p = await writeThreads([{ rootId: "300", status: "active", tweets: [
      tweet({ id: "300", text: "본문", media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문\n\n[사진](https://pbs.twimg.com/media/a.jpg)");
  });

  it("surfaces a video as a paren-free [영상] marker, without the thumbnail url", async () => {
    const p = await writeThreads([{ rootId: "301", status: "active", tweets: [
      tweet({ id: "301", text: "영상 트윗", media: [{ type: "video", url: "https://pbs.twimg.com/amplify_video_thumb/x.jpg" }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("영상 트윗\n\n[영상]");
    expect(item.text).not.toContain("amplify_video_thumb");
  });

  it("puts the mp4 in the [영상] marker when collection captured one", async () => {
    const p = await writeThreads([{ rootId: "303", status: "active", tweets: [
      tweet({ id: "303", text: "영상 트윗", media: [{
        type: "video",
        url: "https://pbs.twimg.com/amplify_video_thumb/x.jpg",
        videoUrl: MP4,
      }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe(`영상 트윗\n\n[영상] ${MP4}`);
    // Paren-free is the whole contract: `[영상](url)` is a markdown link, and `linksToPlain`'s
    // MD_LINK would rewrite it into the delivered text.
    expect(item.text).not.toContain("[영상](");
    // The thumbnail is not the playable file, and putting it here would deliver a still image.
    expect(item.text).not.toContain("amplify_video_thumb");
  });

  it("uses the same marker for an animated_gif", async () => {
    const p = await writeThreads([{ rootId: "304", status: "active", tweets: [
      tweet({ id: "304", text: "gif", media: [{ type: "animated_gif", url: "https://pbs.twimg.com/t.jpg", videoUrl: MP4 }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe(`gif\n\n[영상] ${MP4}`);
  });

  it("appends nothing to a text-only post", async () => {
    const p = await writeThreads([{ rootId: "302", status: "active", tweets: [tweet({ id: "302", text: "본문만" })] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문만");
  });
});

describe("XContentSource → extractMedia round trip", () => {
  it("hands the send path the mp4 a collected tweet carried", async () => {
    // The reviewed text is the pipeline's only source of truth for media, so the marker written
    // here has to survive being read back — including the `?tag=14` query the mp4 urls carry.
    const p = await writeThreads([{ rootId: "305", status: "active", tweets: [
      tweet({ id: "305", text: "영상 트윗", media: [{ type: "video", url: "https://pbs.twimg.com/t.jpg", videoUrl: MP4 }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    const extracted = extractMedia(item.text);
    expect(extracted.videos).toEqual([MP4]);
    expect(extracted.photos).toEqual([]);
    // The marker line goes, and so does the blank line it sat behind — exactly as for a bare [영상].
    expect(extracted.text).toBe("영상 트윗");
    expect(stripMedia(item.text)).toBe(stripMedia("영상 트윗\n\n[영상]"));
  });
});
