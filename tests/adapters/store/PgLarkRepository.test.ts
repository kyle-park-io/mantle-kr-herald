import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../support/testDb";
import { PgLarkRepository } from "../../../src/adapters/store/PgLarkRepository";
import { PgContentSource } from "../../../src/adapters/store/PgContentSource";
import { LarkContentSource } from "../../../src/adapters/content/LarkContentSource";
import type { LarkMessage } from "../../../src/domain/larkMessage";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lark-repo-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function message(messageId: string, over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId,
    chatId: "oc_x",
    msgType: "text",
    createdAt: "2026-01-01T00:00:00.000Z",
    text: `t${messageId}`,
    rawContent: `{"text":"t${messageId}"}`,
    ...over,
  };
}

describe("PgLarkRepository", () => {
  it("round-trips a lark message", async () => {
    db = await createTestDb();
    const store = new PgLarkRepository(db);
    await store.upsert([message("om_1")]);
    expect(await store.loadAll()).toEqual([message("om_1")]);
  });

  it("upserts by messageId (incoming wins) without dropping stored messages", async () => {
    db = await createTestDb();
    const store = new PgLarkRepository(db);
    await store.upsert([message("om_1", { text: "old" }), message("om_2")]);
    await store.upsert([message("om_1", { text: "new" })]); // subset re-collect

    const all = await store.loadAll();
    expect(all.map((m) => m.messageId).sort()).toEqual(["om_1", "om_2"]);
    expect(all.find((m) => m.messageId === "om_1")?.text).toBe("new");
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgLarkRepository(db);
    await store.upsert([message("om_1")]);
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("senderId", null);
    expect(row?.senderId).toBeUndefined();
    expect(row?.threadId).toBeUndefined();
    expect(row?.parentId).toBeUndefined();
  });

  it("keeps optional fields when present", async () => {
    db = await createTestDb();
    const store = new PgLarkRepository(db);
    await store.upsert([message("om_1", { senderId: "ou_1", threadId: "omt_1", parentId: "om_0" })]);
    const [row] = await store.loadAll();
    expect(row?.senderId).toBe("ou_1");
    expect(row?.threadId).toBe("omt_1");
    expect(row?.parentId).toBe("om_0");
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgLarkRepository(db);
    await Promise.all([store.upsert([message("om_1")]), store.upsert([message("om_2")])]);
    const all = await store.loadAll();
    expect(all.map((m) => m.messageId).sort()).toEqual(["om_1", "om_2"]);
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgLarkRepository(localDb);
    await store.upsert([message("om_1")]);
    await store.upsert([message("om_2")]);
    await store.upsert([message("om_3")]);

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from lark_items where id = $1",
      ["om_1"],
    );

    // Update the first-inserted row last — if `upsert` ever touched `ordinal`, this would move
    // om_1 to the end of loadAll() and bump its ordinal value.
    await store.upsert([message("om_1", { text: "고침" })]);

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from lark_items where id = $1",
      ["om_1"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((m) => m.messageId)).toEqual(["om_1", "om_2", "om_3"]);
    expect(all[0]?.text).toBe("고침");
  });

  /**
   * `lark_items` was created in Task 1 and read by `PgContentSource` (Task 13) before this store
   * ever wrote to it, so the two were never checked against each other. This is that check: the
   * same message, stored through `PgLarkRepository` and read back through
   * `PgContentSource.loadPending`, must produce the exact `ContentItem` that `LarkContentSource`
   * produces from the equivalent file — proving the writer and the reader agree on every column
   * `flattenLarkMessages` touches (`id`/`text`/`created_at`).
   */
  it("agrees with PgContentSource and LarkContentSource on the same message", async () => {
    db = await createTestDb();
    const m = message("om_1", {
      chatId: "oc_x",
      msgType: "post",
      createdAt: "2026-01-05T00:00:00.000Z",
      senderId: "ou_1",
      threadId: "omt_1",
      text: "안녕 Mantle",
      rawContent: '{"title":"안녕 Mantle"}',
    });

    await new PgLarkRepository(db).upsert([m]);
    const fromDb = await new PgContentSource(db).loadPending(new Set());

    const itemsPath = join(dir, "items.json");
    await writeFile(itemsPath, JSON.stringify([m]), "utf8");
    const fromFile = await new LarkContentSource(itemsPath).loadPending(new Set());

    expect(fromDb).toEqual(fromFile);
    expect(fromDb).toEqual([{ id: "lark:om_1", source: "lark", text: "안녕 Mantle", createdAt: "2026-01-05T00:00:00.000Z" }]);
  });
});
