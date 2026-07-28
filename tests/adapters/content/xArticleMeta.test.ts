import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xArticleMeta } from "../../../src/adapters/content/xArticleMeta";

async function file(threads: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "items-"));
  const p = join(dir, "items.json");
  await writeFile(p, JSON.stringify(threads));
  return p;
}

describe("xArticleMeta", () => {
  it("reports an article + its cover url", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{ article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" } }] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: true, coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" });
  });

  it("reports non-article for a plain tweet, unknown id, missing/corrupt file", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{}] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: false });
    expect(await xArticleMeta(p)("x:9")).toEqual({ isArticle: false });
    expect(await xArticleMeta("/no/such.json")("x:1")).toEqual({ isArticle: false });
  });
});
