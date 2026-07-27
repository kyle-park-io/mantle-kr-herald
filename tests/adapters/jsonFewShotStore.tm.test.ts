import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFewShotStore } from "../../src/adapters/store/JsonFewShotStore";

describe("JsonFewShotStore with a custom filename", () => {
  it("reads and writes the named file, not few-shot.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tm-store-"));
    const store = new JsonFewShotStore(dir, "tm.json");
    expect(await store.load()).toEqual([]);
    await store.add({ source: "$MNT news", target: "소식", itemId: "x:1" });
    const onDisk = JSON.parse(await readFile(join(dir, "tm.json"), "utf8"));
    expect(onDisk).toEqual([{ source: "$MNT news", target: "소식", itemId: "x:1" }]);
  });

  it("still defaults to few-shot.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-store-"));
    const store = new JsonFewShotStore(dir);
    await store.add({ source: "a", target: "b" });
    const onDisk = JSON.parse(await readFile(join(dir, "few-shot.json"), "utf8"));
    expect(onDisk).toHaveLength(1);
  });
});
