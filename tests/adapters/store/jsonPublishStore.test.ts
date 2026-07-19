import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonPublishStore } from "../../../src/adapters/store/JsonPublishStore";
import type { SyncEntry } from "../../../src/domain/publish/syncLedger";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publish-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return { itemId: "x:1", stage: "translation", status: "translated", target: "google", ...overrides };
}

describe("JsonPublishStore", () => {
  it("listPublished is empty initially, then reflects recorded keys", async () => {
    const store = new JsonPublishStore(dir);
    expect((await store.listPublished()).size).toBe(0);
    await store.record(entry({ target: "google" }));
    await store.record(entry({ target: "lark" }));
    const set = await store.listPublished();
    expect(set.has("x:1:translated:google")).toBe(true);
    expect(set.has("x:1:translated:lark")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("record is idempotent for the same key", async () => {
    const store = new JsonPublishStore(dir);
    await store.record(entry());
    await store.record(entry());
    expect((await store.listPublished()).size).toBe(1);
  });

  it("migrates the legacy published-key format on read", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "publish-"));
    await mkdir(dir2, { recursive: true });
    await writeFile(
      join(dir2, "state.json"),
      JSON.stringify({ published: ["x:1934:approved:google", "x:1934:approved:lark"] }),
      "utf8",
    );

    const store = new JsonPublishStore(dir2);
    const entries = await store.listEntries();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.target).sort()).toEqual(["google", "lark"]);
    expect(entries[0].itemId).toBe("x:1934");
    expect(await store.listPublished()).toEqual(new Set(["x:1934:approved:google", "x:1934:approved:lark"]));
  });

  it("upserts by (itemId, status, target) so a re-upload replaces the old row", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "publish-"));
    const store = new JsonPublishStore(dir2);

    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "a", contentHash: "sha256:aa", uploadedAt: "2026-07-20T00:00:00.000Z" });
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "b", contentHash: "sha256:bb", uploadedAt: "2026-07-21T00:00:00.000Z" });
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "lark", remoteId: "c" });

    const entries = await store.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.target === "google")?.remoteId).toBe("b");
    expect(entries.find((e) => e.target === "lark")?.remoteId).toBe("c");
  });
});
