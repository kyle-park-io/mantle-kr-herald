import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xPhotos } from "../../../src/adapters/content/xMediaLookup";

async function itemsFile(threads: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "items-"));
  const path = join(dir, "items.json");
  await writeFile(path, JSON.stringify(threads));
  return path;
}

describe("xPhotos", () => {
  it("returns a post's photo urls (type photo only), order preserved", async () => {
    const path = await itemsFile([
      { rootId: "1", status: "active", tweets: [{ media: [
        { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
        { type: "video", url: "https://pbs.twimg.com/amplify_video_thumb/b.jpg" },
      ] }] },
    ]);
    expect(await xPhotos(path)("x:1")).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
  });

  it("concatenates photos across a thread's tweets", async () => {
    const path = await itemsFile([
      { rootId: "1", status: "active", tweets: [
        { media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] },
        { media: [{ type: "photo", url: "https://pbs.twimg.com/media/b.jpg" }] },
      ] },
    ]);
    expect(await xPhotos(path)("x:1")).toEqual(["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"]);
  });

  it("returns [] for a text-only or unknown item, and for a bad path", async () => {
    const path = await itemsFile([{ rootId: "1", status: "active", tweets: [{}] }]);
    expect(await xPhotos(path)("x:1")).toEqual([]);
    expect(await xPhotos(path)("x:9")).toEqual([]);
    expect(await xPhotos("/no/such/file.json")("x:1")).toEqual([]);
  });

  it("returns [] for a corrupt items.json instead of throwing (must not fail a text-only send)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "items-"));
    const path = join(dir, "items.json");
    await writeFile(path, "{ not valid json");
    expect(await xPhotos(path)("x:1")).toEqual([]);
  });
});
