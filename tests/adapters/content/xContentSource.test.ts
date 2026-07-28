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

  it("prefixes a nested commenter-reply (isReply + leading @), but not the root or a self-continuation", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [
      tweet({ id: "100", text: "24/7 access to markets" }),                  // root, isReply false
      tweet({ id: "101", text: "Come Saturday, trade here", isReply: true }), // self-continuation, no @
      tweet({ id: "102", text: "@churchi 🫡", isReply: true }),                // commenter-reply
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe(
      "24/7 access to markets\n\n---\n\nCome Saturday, trade here\n\n---\n\n(댓글 · 지워도 됨) @churchi 🫡",
    );
  });

  it("does not inline-mark a root commenter-reply (index 0)", async () => {
    const path = await writeThreads([{ rootId: "200", status: "active", tweets: [
      tweet({ id: "200", text: "@someone thanks", isReply: true }),
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe("@someone thanks"); // unmarked; PR #66's header marker handles a standalone reply
  });
});

describe("XContentSource media markers", () => {
  it("surfaces a post's photo as an empty-alt image marker after the text", async () => {
    const p = await writeThreads([{ rootId: "300", status: "active", tweets: [
      tweet({ id: "300", text: "본문", media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문\n\n![](https://pbs.twimg.com/media/a.jpg)");
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
