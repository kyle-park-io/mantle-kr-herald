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
});
