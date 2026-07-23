import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XContentSource } from "../../../src/adapters/content/XContentSource";
import { LarkContentSource } from "../../../src/adapters/content/LarkContentSource";
import { CompositeContentSource } from "../../../src/adapters/content/CompositeContentSource";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "content-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("XContentSource", () => {
  it("maps active threads to ContentItem (joined text, x: id) and excludes translated + deleted", async () => {
    const items = [
      {
        rootId: "100", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "100", conversationId: "100", text: "Line A", createdAt: "2026-01-01T00:01:00.000Z", url: "u/100", authorUserName: "Mantle_Official", isReply: false, isQuote: false },
          { id: "101", conversationId: "100", text: "Line B", createdAt: "2026-01-01T00:02:00.000Z", url: "u/101", authorUserName: "Mantle_Official", isReply: true, isQuote: false },
        ],
      },
      { rootId: "200", status: "deleted", firstSeenAt: "x", tweets: [{ id: "200", conversationId: "200", text: "gone", createdAt: "2026-01-01T00:00:00.000Z", url: "u", authorUserName: "Mantle_Official", isReply: false, isQuote: false }] },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set(["x:999"]));

    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("x:100");
    expect(pending[0].source).toBe("x");
    expect(pending[0].text).toContain("Line A");
    expect(pending[0].text).toContain("Line B");
    // tweets within a thread are separated by a horizontal rule, not just a blank line
    expect(pending[0].text).toBe("Line A\n\n---\n\nLine B");
    expect(pending[0].refUrl).toBe("u/100");
  });

  it("excludes already-translated threads", async () => {
    const items = [{ rootId: "100", status: "active", firstSeenAt: "x", tweets: [{ id: "100", conversationId: "100", text: "t", createdAt: "2026-01-01T00:00:00.000Z", url: "u", authorUserName: "a", isReply: false, isQuote: false }] }];
    await writeFile(join(dir, "items.json"), JSON.stringify(items), "utf8");
    const pending = await new XContentSource(join(dir, "items.json")).loadPending(new Set(["x:100"]));
    expect(pending).toHaveLength(0);
  });

  it("returns [] when the file is absent", async () => {
    const pending = await new XContentSource(join(dir, "missing.json")).loadPending(new Set());
    expect(pending).toEqual([]);
  });

  it("renders an article body as markdown and marks the item as an article", async () => {
    const items = [
      {
        rootId: "300",
        status: "active",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          {
            id: "300", conversationId: "300", text: "https://t.co/pa1EbjOsdZ",
            createdAt: "2026-01-01T00:01:00.000Z", url: "u/300",
            authorUserName: "Mantle_Official", isReply: false, isQuote: false,
            article: {
              title: "Phase 1: ClawHack",
              blocks: [
                { type: "header-two", text: "Section" },
                { type: "divider" },
                { type: "unstyled", text: "Body copy." },
              ],
            },
          },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("article");
    expect(pending[0].text).toBe("# Phase 1: ClawHack\n\n## Section\n\nBody copy.");
    // The bare t.co link the tweet carried must not be what we translate.
    expect(pending[0].text).not.toContain("t.co");
  });

  it("marks an ordinary thread as a post and leaves its text untouched", async () => {
    const items = [
      {
        rootId: "400", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "400", conversationId: "400", text: "Plain", createdAt: "2026-01-01T00:01:00.000Z", url: "u/400", authorUserName: "Mantle_Official", isReply: false, isQuote: false },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending[0].kind).toBe("post");
    expect(pending[0].text).toBe("Plain");
  });

  it("falls back to the tweet text when an article has no fetched body", async () => {
    const items = [
      {
        rootId: "500", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "500", conversationId: "500", text: "https://t.co/abc", createdAt: "2026-01-01T00:01:00.000Z", url: "u/500", authorUserName: "Mantle_Official", isReply: false, isQuote: false, article: { title: "No body" } },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending[0].kind).toBe("post");
    expect(pending[0].text).toBe("https://t.co/abc");
  });
});

describe("LarkContentSource", () => {
  it("maps messages to ContentItem (lark: id) and excludes translated", async () => {
    const msgs = [
      { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "안녕 Mantle", rawContent: "{}" },
      { messageId: "om_2", chatId: "oc", msgType: "post", createdAt: "2026-01-02T00:00:00.000Z", text: "post text", rawContent: "{}" },
    ];
    await writeFile(join(dir, "lark-items.json"), JSON.stringify(msgs), "utf8");
    const pending = await new LarkContentSource(join(dir, "lark-items.json")).loadPending(new Set(["lark:om_2"]));
    expect(pending.map((p) => p.id)).toEqual(["lark:om_1"]);
    expect(pending[0].source).toBe("lark");
    expect(pending[0].text).toBe("안녕 Mantle");
  });
});

describe("CompositeContentSource", () => {
  it("concatenates pending from all sources", async () => {
    const a: ContentItem[] = [{ id: "x:1", source: "x", text: "a", createdAt: "2026-01-01T00:00:00.000Z" }];
    const b: ContentItem[] = [{ id: "lark:1", source: "lark", text: "b", createdAt: "2026-01-02T00:00:00.000Z" }];
    const composite = new CompositeContentSource([
      { loadPending: async () => a },
      { loadPending: async () => b },
    ]);
    const pending = await composite.loadPending(new Set());
    expect(pending.map((p) => p.id)).toEqual(["x:1", "lark:1"]);
  });
});
