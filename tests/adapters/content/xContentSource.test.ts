import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XContentSource } from "../../../src/adapters/content/XContentSource";

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

  it("appends nothing to a text-only post", async () => {
    const p = await writeThreads([{ rootId: "302", status: "active", tweets: [tweet({ id: "302", text: "본문만" })] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문만");
  });
});
