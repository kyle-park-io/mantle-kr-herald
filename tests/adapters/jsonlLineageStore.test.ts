import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLineageStore } from "../../src/adapters/store/JsonlLineageStore";
import type { LineageEntry } from "../../src/domain/lineage/models";

const entry = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "안녕", status: "translated", at: "2026-07-28T00:00:00.000Z", ...over,
});

describe("JsonlLineageStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lineage-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("appends and loads entries in order for an id containing ':'", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry({ content: "v1" }));
    await s.append(entry({ content: "v2" }));
    const got = await s.load("x:1");
    expect(got.map((e) => e.content)).toEqual(["v1", "v2"]);
  });

  it("writes to a ':'-sanitized filename (x:1 -> x_1.jsonl)", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry());
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toContain("x_1.jsonl");
  });

  it("returns [] for an item with no file", async () => {
    expect(await new JsonlLineageStore(dir).load("x:404")).toEqual([]);
  });

  it("skips a malformed line and loads the rest", async () => {
    await writeFile(join(dir, "x_1.jsonl"), JSON.stringify(entry({ content: "ok" })) + "\n{bad json\n", "utf8");
    const got = await new JsonlLineageStore(dir).load("x:1");
    expect(got.map((e) => e.content)).toEqual(["ok"]);
  });

  it("listItems reports id, entry count, and last stage", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry({ stage: "translated" }));
    await s.append(entry({ stage: "converted", variant: "announcement" }));
    expect(await s.listItems()).toEqual([{ itemId: "x:1", entries: 2, lastStage: "converted" }]);
  });

  it("listEvents flattens every item's file into one list", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry({ itemId: "x:1", stage: "translated" }));
    await s.append(entry({ itemId: "lark:2", stage: "converted" }));
    const events = await s.listEvents();
    // Order across items is unspecified by the port (one file per item, `readdir` order), so this
    // asserts membership rather than sequence.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.itemId).sort()).toEqual(["lark:2", "x:1"]);
    expect(events.every((e) => e.at === "2026-07-28T00:00:00.000Z")).toBe(true);
  });

  it("listEvents returns [] when the directory does not exist", async () => {
    expect(await new JsonlLineageStore(join(dir, "nope")).listEvents()).toEqual([]);
  });
});
