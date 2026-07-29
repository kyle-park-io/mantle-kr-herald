import { describe, it, expect } from "vitest";
import {
  assembleStateSnapshot,
  countRows,
  diffRowCounts,
  parseStateSnapshot,
  snapshotName,
  unknownStatePaths,
  STATE_SNAPSHOT_PREFIX,
} from "../../../src/domain/state/snapshot";

describe("operational-state snapshot", () => {
  it("round-trips the tracked files through assemble → parse", () => {
    const files = [
      { path: "output/formatted/overrides.json", content: '[{"itemId":"x:1"}]' },
      { path: "output/publish/deliveries.json", content: "[]" },
    ];
    const json = assembleStateSnapshot(files, () => "2026-07-29T00:00:00.000Z");
    expect(parseStateSnapshot(json)).toEqual(files);
    expect(JSON.parse(json).pushedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("names snapshots with the prefix latest() searches for, and no colons", () => {
    const name = snapshotName("2026-07-29T01:02:03.456Z");
    expect(name.startsWith(STATE_SNAPSHOT_PREFIX)).toBe(true);
    expect(name).toBe("operational-state-2026-07-29T01-02-03-456Z.json");
  });

  it("names the operational state, not the config, when a download is corrupt", () => {
    expect(() => parseStateSnapshot("not json")).toThrow(/not a valid operational state bundle/);
    expect(() => parseStateSnapshot(JSON.stringify({ version: 1 }))).toThrow(/not a valid operational state bundle/);
  });
});

describe("countRows", () => {
  it("counts a bare array — overrides, deliveries, x-article", () => {
    expect(countRows("[]")).toBe(0);
    expect(countRows('[{"a":1},{"a":2},{"a":3}]')).toBe(3);
  });

  it("counts publish/state.json in both its current and legacy shapes", () => {
    expect(countRows('{"entries":[{"itemId":"x:1"},{"itemId":"x:2"}]}')).toBe(2);
    expect(countRows('{"published":["x:1:approved:gdrive"]}')).toBe(1);
  });

  it("returns undefined — not 0 — for a shape it cannot count", () => {
    // 0 would read as "nothing to lose" at the exact moment the operator decides to overwrite.
    expect(countRows("not json")).toBeUndefined();
    expect(countRows('{"something":"else"}')).toBeUndefined();
    expect(countRows("42")).toBeUndefined();
  });
});

describe("diffRowCounts", () => {
  const local = [
    { path: "output/publish/deliveries.json", content: '[{"a":1},{"a":2}]' },
    { path: "output/publish/x-article.json", content: '[{"a":1}]' },
  ];
  const incoming = [
    { path: "output/publish/deliveries.json", content: '[{"a":1},{"a":2},{"a":3}]' },
    { path: "output/formatted/overrides.json", content: '[{"a":1}]' },
  ];

  it("puts the current row count beside the snapshot's for a file in both", () => {
    const diff = diffRowCounts(local, incoming);
    expect(diff[0]).toEqual({
      path: "output/publish/deliveries.json",
      current: 2,
      incoming: 3,
      change: "overwrite",
    });
  });

  it("marks a file only the snapshot has as a restore, with nothing to lose", () => {
    const diff = diffRowCounts(local, incoming);
    expect(diff[1]).toEqual({ path: "output/formatted/overrides.json", current: undefined, incoming: 1, change: "restore" });
  });

  it("marks a file only the local tree has as kept — a pull never deletes", () => {
    const diff = diffRowCounts(local, incoming);
    const kept = diff.find((d) => d.path === "output/publish/x-article.json");
    expect(kept).toEqual({ path: "output/publish/x-article.json", current: 1, change: "keep" });
  });

  it("lists every file exactly once, snapshot order first", () => {
    expect(diffRowCounts(local, incoming).map((d) => d.path)).toEqual([
      "output/publish/deliveries.json",
      "output/formatted/overrides.json",
      "output/publish/x-article.json",
    ]);
  });

  it("reports an unknown row shape rather than guessing a count", () => {
    const diff = diffRowCounts([{ path: "p", content: "{{{" }], [{ path: "p", content: "}}}" }]);
    expect(diff).toEqual([{ path: "p", current: undefined, incoming: undefined, change: "overwrite" }]);
  });
});

describe("unknownStatePaths", () => {
  const tracked = ["output/publish/deliveries.json", "output/formatted/overrides.json"];

  it("is empty when the snapshot holds only tracked files", () => {
    expect(unknownStatePaths([{ path: tracked[0], content: "[]" }], tracked)).toEqual([]);
  });

  it("names a file this version does not track", () => {
    const incoming = [
      { path: tracked[0], content: "[]" },
      { path: "output/publish/future-ledger.json", content: "[]" },
    ];
    expect(unknownStatePaths(incoming, tracked)).toEqual(["output/publish/future-ledger.json"]);
  });

  it("catches a path trying to escape the repo", () => {
    expect(unknownStatePaths([{ path: "../../.ssh/authorized_keys", content: "x" }], tracked)).toEqual([
      "../../.ssh/authorized_keys",
    ]);
  });
});
