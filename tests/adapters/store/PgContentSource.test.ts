import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgContentSource, PgXContentSource, PgLarkContentSource } from "../../../src/adapters/store/PgContentSource";
import type { CollectedThread, SourceTweet } from "../../../src/domain/models";
import type { LarkMessage } from "../../../src/domain/larkMessage";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function tweet(o: Partial<SourceTweet> & { id: string }): SourceTweet {
  return {
    conversationId: "100", text: "t", createdAt: "2026-07-28T00:00:00Z",
    url: "https://x.com/a/status/100", authorUserName: "a", isReply: false, isQuote: false, ...o,
  };
}

async function insertThread(d: NonNullable<typeof db>, t: CollectedThread): Promise<void> {
  await d.query(
    `insert into x_threads (root_id, tweets, status, first_seen_at, deleted_at) values ($1, $2, $3, $4, $5)`,
    [t.rootId, JSON.stringify(t.tweets), t.status, t.firstSeenAt, t.deletedAt ?? null],
  );
}

async function insertLark(d: NonNullable<typeof db>, m: LarkMessage): Promise<void> {
  await d.query(
    `insert into lark_items (id, chat_id, msg_type, created_at, sender_id, thread_id, parent_id, text, raw_content)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [m.messageId, m.chatId, m.msgType, m.createdAt, m.senderId ?? null, m.threadId ?? null, m.parentId ?? null, m.text, m.rawContent],
  );
}

describe("PgContentSource", () => {
  it("returns [] when both tables are empty", async () => {
    db = await createTestDb();
    const pending = await new PgContentSource(db).loadPending(new Set());
    expect(pending).toEqual([]);
  });

  it("maps active X threads to ContentItem (joined text, x: id) and excludes deleted", async () => {
    db = await createTestDb();
    await insertThread(db, {
      rootId: "100", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
      tweets: [
        tweet({ id: "100", conversationId: "100", text: "Line A", createdAt: "2026-01-01T00:01:00.000Z", url: "u/100" }),
        tweet({ id: "101", conversationId: "100", text: "Line B", createdAt: "2026-01-01T00:02:00.000Z", url: "u/101", isReply: true }),
      ],
    });
    await insertThread(db, {
      rootId: "200", status: "deleted", firstSeenAt: "x",
      tweets: [tweet({ id: "200", conversationId: "200", text: "gone" })],
    });

    const pending = await new PgContentSource(db).loadPending(new Set(["x:999"]));

    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("x:100");
    expect(pending[0].source).toBe("x");
    expect(pending[0].text).toBe("Line A\n\n---\n\nLine B");
    expect(pending[0].refUrl).toBe("u/100");
  });

  it("excludes an X thread whose id is already in translatedIds", async () => {
    db = await createTestDb();
    await insertThread(db, {
      rootId: "100", status: "active", firstSeenAt: "x",
      tweets: [tweet({ id: "100" })],
    });
    const pending = await new PgContentSource(db).loadPending(new Set(["x:100"]));
    expect(pending).toHaveLength(0);
  });

  it("renders an article body as markdown and marks the item as an article", async () => {
    db = await createTestDb();
    await insertThread(db, {
      rootId: "300", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
      tweets: [
        tweet({
          id: "300", conversationId: "300", text: "https://t.co/pa1EbjOsdZ",
          createdAt: "2026-01-01T00:01:00.000Z", url: "u/300",
          article: {
            title: "Phase 1: ClawHack",
            blocks: [
              { type: "header-two", text: "Section" },
              { type: "divider" },
              { type: "unstyled", text: "Body copy." },
            ],
          },
        }),
      ],
    });

    const pending = await new PgContentSource(db).loadPending(new Set());

    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("article");
    expect(pending[0].text).toBe("# Phase 1: ClawHack\n\n## Section\n\nBody copy.");
    expect(pending[0].text).not.toContain("t.co");
  });

  it("surfaces a post's photo as a media marker, matching XContentSource", async () => {
    db = await createTestDb();
    await insertThread(db, {
      rootId: "300", status: "active", firstSeenAt: "x",
      tweets: [tweet({ id: "300", text: "본문", media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] })],
    });
    const pending = await new PgContentSource(db).loadPending(new Set());
    expect(pending[0].text).toBe("본문\n\n![](https://pbs.twimg.com/media/a.jpg)");
  });

  it("maps Lark messages to ContentItem (lark: id) and excludes translated", async () => {
    db = await createTestDb();
    await insertLark(db, { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "안녕 Mantle", rawContent: "{}" });
    await insertLark(db, { messageId: "om_2", chatId: "oc", msgType: "post", createdAt: "2026-01-02T00:00:00.000Z", text: "post text", rawContent: "{}" });

    const pending = await new PgContentSource(db).loadPending(new Set(["lark:om_2"]));

    expect(pending.map((p) => p.id)).toEqual(["lark:om_1"]);
    expect(pending[0].source).toBe("lark");
    expect(pending[0].text).toBe("안녕 Mantle");
  });

  it("orders X items before Lark items, matching CompositeContentSource([x, lark])", async () => {
    db = await createTestDb();
    await insertLark(db, { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "lark", rawContent: "{}" });
    await insertThread(db, { rootId: "100", status: "active", firstSeenAt: "x", tweets: [tweet({ id: "100" })] });

    const pending = await new PgContentSource(db).loadPending(new Set());

    expect(pending.map((p) => p.id)).toEqual(["x:100", "lark:om_1"]);
  });
});

describe("PgXContentSource", () => {
  it("returns only X items, even when lark_items also holds rows", async () => {
    db = await createTestDb();
    await insertThread(db, { rootId: "100", status: "active", firstSeenAt: "x", tweets: [tweet({ id: "100" })] });
    await insertLark(db, { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "lark", rawContent: "{}" });

    const pending = await new PgXContentSource(db).loadPending(new Set());

    expect(pending.map((p) => p.id)).toEqual(["x:100"]);
  });
});

describe("PgLarkContentSource", () => {
  it("returns only Lark items, even when x_threads also holds rows", async () => {
    db = await createTestDb();
    await insertThread(db, { rootId: "100", status: "active", firstSeenAt: "x", tweets: [tweet({ id: "100" })] });
    await insertLark(db, { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "lark", rawContent: "{}" });

    const pending = await new PgLarkContentSource(db).loadPending(new Set());

    expect(pending.map((p) => p.id)).toEqual(["lark:om_1"]);
  });
});
