import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgTranslationStore } from "../../../src/adapters/store/PgTranslationStore";
import type { Translation } from "../../../src/domain/translation/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function translation(itemId: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId, source: "x", sourceText: "s", koreanText: "ko",
    status: "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("PgTranslationStore", () => {
  it("round-trips a translation", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    expect(await store.loadAll()).toEqual([translation("x:1")]);
  });

  it("upserts by itemId rather than appending", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    await store.upsert(translation("x:1", { koreanText: "고침", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.koreanText).toBe("고침");
    expect(all[0]?.status).toBe("approved");
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("approvedAt", null);
    expect(row?.approvedAt).toBeUndefined();
  });

  it("listTranslatedIds returns every stored itemId", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    await store.upsert(translation("lark:2", { source: "lark" }));
    expect([...(await store.listTranslatedIds())].sort()).toEqual(["lark:2", "x:1"]);
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await Promise.all([store.upsert(translation("x:1")), store.upsert(translation("x:2"))]);
    expect(await store.listTranslatedIds()).toEqual(new Set(["x:1", "x:2"]));
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgTranslationStore(localDb);
    await store.upsert(translation("x:1"));
    await store.upsert(translation("x:2"));
    await store.upsert(translation("x:3"));

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from translations where item_id = $1",
      ["x:1"],
    );

    // Update the first-inserted row last — if `upsert` ever touched `ordinal`, this would move
    // x:1 to the end of loadAll() and bump its ordinal value.
    await store.upsert(translation("x:1", { koreanText: "고침", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from translations where item_id = $1",
      ["x:1"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((t) => t.itemId)).toEqual(["x:1", "x:2", "x:3"]);
    expect(all[0]?.koreanText).toBe("고침");
  });
});
