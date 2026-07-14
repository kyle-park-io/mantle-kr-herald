import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonPublishStore } from "../../../src/adapters/store/JsonPublishStore";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publish-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonPublishStore", () => {
  it("listPublished is empty initially, then reflects recorded keys", async () => {
    const store = new JsonPublishStore(dir);
    expect((await store.listPublished()).size).toBe(0);
    await store.record("x:1:translated:google");
    await store.record("x:1:translated:lark");
    const set = await store.listPublished();
    expect(set.has("x:1:translated:google")).toBe(true);
    expect(set.has("x:1:translated:lark")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("record is idempotent for the same key", async () => {
    const store = new JsonPublishStore(dir);
    await store.record("k");
    await store.record("k");
    expect((await store.listPublished()).size).toBe(1);
  });
});
