import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../support/testDb";
import { createStores } from "../../src/cli/stores";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("createStores", () => {
  it("wires the translation-scope few-shot store separately from the per-type conversion stores", async () => {
    db = await createTestDb();
    const stores = createStores(db);

    await stores.fewShotStore.add({ source: "hello", target: "안녕" });
    await stores.fewShotStoresByType.announcement.add({ source: "bye", target: "안녕히" });

    // Different scopes must not leak into each other's corpus.
    expect(await stores.fewShotStore.load()).toEqual([{ source: "hello", target: "안녕" }]);
    expect(await stores.fewShotStoresByType.announcement.load()).toEqual([{ source: "bye", target: "안녕히" }]);
  });

  it("wires xContentSource/larkContentSource to their own table only, and contentSource to both", async () => {
    db = await createTestDb();
    const stores = createStores(db);

    await db.query(
      `insert into x_threads (root_id, tweets, status, first_seen_at, deleted_at) values ($1, $2, $3, $4, $5)`,
      [
        "100",
        JSON.stringify([
          {
            id: "100",
            conversationId: "100",
            text: "t",
            createdAt: "2026-01-01T00:00:00Z",
            url: "https://x.com/a/status/100",
            authorUserName: "a",
            isReply: false,
            isQuote: false,
          },
        ]),
        "active",
        "2026-01-01T00:00:00.000Z",
        null,
      ],
    );
    await db.query(
      `insert into lark_items (id, chat_id, msg_type, created_at, sender_id, thread_id, parent_id, text, raw_content)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ["om_1", "oc", "text", "2026-01-02T00:00:00.000Z", null, null, null, "lark text", "{}"],
    );

    expect((await stores.xContentSource.loadPending(new Set())).map((p) => p.id)).toEqual(["x:100"]);
    expect((await stores.larkContentSource.loadPending(new Set())).map((p) => p.id)).toEqual(["lark:om_1"]);
    expect((await stores.contentSource.loadPending(new Set())).map((p) => p.id)).toEqual(["x:100", "lark:om_1"]);
  });

  it("returns stores that round-trip through the database for the pipeline's core tables", async () => {
    db = await createTestDb();
    const stores = createStores(db);

    await stores.translationStore.upsert({
      itemId: "x:1",
      source: "x",
      sourceText: "s",
      koreanText: "ko",
      status: "translated",
      translatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await stores.translationStore.loadAll()).toHaveLength(1);

    await stores.deliveryLedger.add({
      itemId: "x:1",
      type: "announcement",
      outletId: "tg-community",
      status: "sent",
      at: "2026-01-01T00:00:00.000Z",
      by: "auto",
    });
    expect(await stores.deliveryLedger.loadKeys()).toEqual(new Set(["x:1:announcement:tg-community"]));

    await stores.lineageStore.append({ itemId: "x:1", stage: "translated", content: "ko", at: "2026-01-01T00:00:00.000Z" });
    expect(await stores.lineageStore.load("x:1")).toHaveLength(1);
  });
});
