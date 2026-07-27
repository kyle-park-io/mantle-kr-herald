import { describe, it, expect } from "vitest";
import { selectRelevantTm } from "../../../src/domain/tm/selection";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { FewShotExample } from "../../../src/domain/translation/models";

const batch: ContentItem[] = [
  { id: "x:1", source: "x", text: "$MNT staking goes live #Mantle", createdAt: "2026-07-20T00:00:00Z" },
];

const tm: FewShotExample[] = [
  { source: "$MNT rewards #Mantle @Bybit_Official", target: "리워드", itemId: "x:a" }, // shares $mnt,#mantle = 2
  { source: "$MNT news", target: "소식", itemId: "x:b" },                              // shares $mnt = 1
  { source: "unrelated $OTHER #Foo", target: "무관", itemId: "x:c" },                   // shares nothing = 0
];

describe("selectRelevantTm", () => {
  it("ranks by anchor overlap and drops zero-overlap pairs", () => {
    const got = selectRelevantTm(batch, tm, 5);
    expect(got.map((e) => e.itemId)).toEqual(["x:a", "x:b"]);
  });

  it("caps at k", () => {
    expect(selectRelevantTm(batch, tm, 1).map((e) => e.itemId)).toEqual(["x:a"]);
  });

  it("returns [] for an empty TM", () => {
    expect(selectRelevantTm(batch, [], 5)).toEqual([]);
  });

  it("returns [] when nothing in the batch shares an anchor", () => {
    const other: ContentItem[] = [{ id: "x:9", source: "x", text: "plain text", createdAt: "2026-07-20T00:00:00Z" }];
    expect(selectRelevantTm(other, tm, 5)).toEqual([]);
  });
});
