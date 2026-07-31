import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xArticleMeta, pgXArticleMeta } from "../../../src/adapters/content/xArticleMeta";
import { createTestDb } from "../../support/testDb";

async function file(threads: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "items-"));
  const p = join(dir, "items.json");
  await writeFile(p, JSON.stringify(threads));
  return p;
}

describe("xArticleMeta", () => {
  it("reports an article (with body blocks) + its cover url", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{ article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg", blocks: [{ type: "unstyled", text: "body" }] } }] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: true, coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" });
  });

  it("is NOT an article when the article has no body blocks (metadata-only, matches XContentSource)", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{ article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" } }] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: false });
  });

  it("reports non-article for a plain tweet, unknown id, and a missing file", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{}] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: false });
    expect(await xArticleMeta(p)("x:9")).toEqual({ isArticle: false });
    expect(await xArticleMeta("/no/such.json")("x:1")).toEqual({ isArticle: false });
  });

  it("returns non-article for a corrupt items.json instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "items-"));
    const p = join(dir, "items.json");
    await writeFile(p, "{ not valid json");
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: false });
  });
});

describe("pgXArticleMeta", () => {
  let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function insertThread(d: NonNullable<typeof db>, rootId: string, tweets: unknown[]): Promise<void> {
    await d.query(
      `insert into x_threads (root_id, tweets, status, first_seen_at, deleted_at) values ($1, $2, $3, $4, $5)`,
      [rootId, JSON.stringify(tweets), "active", "2026-01-01T00:00:00.000Z", null],
    );
  }

  it("reports an article (with body blocks) + its cover url, matching xArticleMeta", async () => {
    db = await createTestDb();
    await insertThread(db, "1", [
      { article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg", blocks: [{ type: "unstyled", text: "body" }] } },
    ]);
    expect(await pgXArticleMeta(db)("x:1")).toEqual({ isArticle: true, coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" });
  });

  it("is NOT an article when the article has no body blocks (metadata-only)", async () => {
    db = await createTestDb();
    await insertThread(db, "1", [{ article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" } }]);
    expect(await pgXArticleMeta(db)("x:1")).toEqual({ isArticle: false });
  });

  it("reports non-article for a plain tweet, and for an unknown id", async () => {
    db = await createTestDb();
    await insertThread(db, "1", [{}]);
    expect(await pgXArticleMeta(db)("x:1")).toEqual({ isArticle: false });
    expect(await pgXArticleMeta(db)("x:9")).toEqual({ isArticle: false });
  });

  it("reports non-article for a non-x itemId without querying the database", async () => {
    db = await createTestDb();
    expect(await pgXArticleMeta(db)("lark:1")).toEqual({ isArticle: false });
  });
});
