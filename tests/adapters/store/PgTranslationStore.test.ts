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

  it("round-trips postedUrl and postedAt", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1", {
      status: "posted",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-07-31T05:39:41.000Z",
    }));
    const [row] = await store.loadAll();
    expect(row?.status).toBe("posted");
    expect(row?.postedUrl).toBe("https://x.com/0xMantleKR/status/999");
    expect(row?.postedAt).toBe("2026-07-31T05:39:41.000Z");
  });

  it("clears postedUrl and postedAt on a plain update that omits them", async () => {
    // upsert writes a whole row — an update that no longer carries postedUrl/postedAt must clear
    // the column, the same as every other optional field here (see the ordinal test below for the
    // one thing an update must NOT touch).
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1", {
      status: "posted",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-07-31T05:39:41.000Z",
    }));
    await store.upsert(translation("x:1", { status: "translated" }));
    const [row] = await store.loadAll();
    expect(row?.postedUrl).toBeUndefined();
    expect(row?.postedAt).toBeUndefined();
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

  it("round-trips publishedText", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1", { publishedText: "실제로 올라간 한국어" }));
    const [row] = await store.loadAll();
    expect(row?.publishedText).toBe("실제로 올라간 한국어");
  });

  it("omits publishedText entirely when the column is null", async () => {
    // omitNulls contract: an absent value must not come back as `null`, or every
    // `publishedText === undefined` check downstream silently stops working.
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:2"));
    const [row] = await store.loadAll();
    expect(row).toBeDefined();
    expect(row && "publishedText" in row).toBe(false);
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
