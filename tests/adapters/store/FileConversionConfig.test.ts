import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversionConfig } from "../../../src/adapters/store/FileConversionConfig";
import { JsonTypedFewShotStore } from "../../../src/adapters/store/JsonTypedFewShotStore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "conv-cfg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("FileConversionConfig", () => {
  it("reads conversion/<type>.md", async () => {
    await writeFile(join(dir, "x.md"), "X 유형 지침", "utf8");
    expect(await new FileConversionConfig(dir).loadTypeGuide("x")).toEqual({ text: "X 유형 지침" });
  });
  it("returns empty text when the guide file is missing", async () => {
    expect(await new FileConversionConfig(dir).loadTypeGuide("pr")).toEqual({ text: "" });
  });
});

describe("JsonTypedFewShotStore", () => {
  it("reads/writes few-shot.<type>.json and upserts by itemId", async () => {
    const store = new JsonTypedFewShotStore(dir, "kol");
    expect(await store.load()).toEqual([]);
    await store.add({ source: "a", target: "b", itemId: "x:1" });
    await store.add({ source: "a2", target: "b2", itemId: "x:1" }); // replace
    await store.add({ source: "c", target: "d", itemId: "x:2" });
    const all = await store.load();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.itemId === "x:1")?.target).toBe("b2");
  });
});
