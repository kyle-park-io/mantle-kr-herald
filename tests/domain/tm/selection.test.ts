import { describe, it, expect } from "vitest";
import { selectRelevantTm, selectPrecedents } from "../../../src/domain/tm/selection";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { FewShotExample } from "../../../src/domain/translation/models";

const pair = (source: string, target: string): FewShotExample => ({ source, target });

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

describe("selectPrecedents", () => {
  it("ranks precedents by shared-anchor count with the draft source, highest first", () => {
    const tm = [
      pair("gm $MNT and $BTC", "안녕 $MNT $BTC"), // 2 shared
      pair("just $MNT today", "오늘 $MNT"), // 1 shared
      pair("unrelated $ETH", "관련없음 $ETH"), // 0 shared
    ];
    const got = selectPrecedents("$MNT $BTC update", tm, 3);
    expect(got.map((p) => p.source)).toEqual(["gm $MNT and $BTC", "just $MNT today"]);
  });

  it("excludes zero-overlap precedents and caps at k", () => {
    const tm = [pair("$MNT a", "가"), pair("$MNT b", "나"), pair("$MNT c", "다"), pair("$ETH d", "라")];
    const got = selectPrecedents("$MNT", tm, 2);
    expect(got).toHaveLength(2);
    expect(got.every((p) => p.source.includes("$MNT"))).toBe(true);
  });

  it("returns nothing when the draft has no anchors", () => {
    expect(selectPrecedents("plain text no anchors", [pair("$MNT x", "y")], 3)).toEqual([]);
  });
});
