import { describe, it, expect } from "vitest";
import { selectRelevantTm, selectPrecedents } from "../../../src/domain/tm/selection";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { FewShotExample } from "../../../src/domain/translation/models";

const pair = (source: string, target: string): FewShotExample => ({ source, target });

const batch: ContentItem[] = [
  { id: "x:1", source: "x", text: "$MNT staking goes live #Mantle", createdAt: "2026-07-20T00:00:00Z" },
];

const tm: FewShotExample[] = [
  // Jaccard against the batch's {$mnt, #mantle}: x:a shares 2 of the 3 in its union → 2/3;
  // x:b shares 1 of 2 → 0.5; x:c shares nothing → 0 and is dropped by the `> 0` filter.
  { source: "$MNT rewards #Mantle @Bybit_Official", target: "리워드", itemId: "x:a" },
  { source: "$MNT news", target: "소식", itemId: "x:b" },
  { source: "unrelated $OTHER #Foo", target: "무관", itemId: "x:c" },
];

/** A pair that name-drops `extra` unrelated projects on top of `shared` — the shape of a recap thread. */
const bloated = (shared: string, extra: number, itemId: string): FewShotExample => ({
  source: `${shared} ${Array.from({ length: extra }, (_, i) => `@proj${i}`).join(" ")}`,
  target: "월간 요약",
  itemId,
});

describe("selectRelevantTm", () => {
  it("ranks by proportion of anchor overlap and drops zero-overlap pairs", () => {
    const got = selectRelevantTm(batch, tm, 5);
    expect(got.map((e) => e.itemId)).toEqual(["x:a", "x:b"]);
  });

  // The defect this scoring exists to fix. The recap shares MORE anchors in absolute terms (3 vs 2),
  // so raw-count ranking puts it first and its bulk into every prompt; by proportion it is 3/23
  // against the tight pair's 2/3 and it loses. Mirrors the live corpus, where one 22,976자 recap
  // carried 62 anchors and out-ranked every smaller pair.
  it("prefers a tightly matching small pair over a bloated one with more shared anchors", () => {
    const wide: ContentItem[] = [
      { id: "x:2", source: "x", text: "$MNT $BTC $ETH weekly", createdAt: "2026-07-20T00:00:00Z" },
    ];
    const corpus = [
      bloated("$MNT $BTC $ETH", 20, "x:recap"), // 3 shared of its 23 anchors → 3/23
      { source: "$MNT $BTC pairing", target: "페어링", itemId: "x:tight" }, // 2 shared of its 2 → 2/3
    ];
    expect(selectRelevantTm(wide, corpus, 2).map((e) => e.itemId)).toEqual(["x:tight", "x:recap"]);
    expect(selectRelevantTm(wide, corpus, 1).map((e) => e.itemId)).toEqual(["x:tight"]);
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
  it("ranks precedents by proportion of anchor overlap with the draft source, highest first", () => {
    const tm = [
      pair("gm $MNT and $BTC", "안녕 $MNT $BTC"), // 2 of 2 shared → 1.0
      pair("just $MNT today", "오늘 $MNT"), // 1 of 1 shared, draft has 2 → 0.5
      pair("unrelated $ETH", "관련없음 $ETH"), // 0 shared → dropped
    ];
    const got = selectPrecedents("$MNT $BTC update", tm, 3);
    expect(got.map((p) => p.source)).toEqual(["gm $MNT and $BTC", "just $MNT today"]);
  });

  // The alignment pass is where raw-count ranking hurt most: its instruction is "match the phrasing
  // of the 선례", so a monthly recap handed to an ordinary post teaches the wrong register. On the
  // live corpus this reordering cut one real draft's precedent block from 28,521자 to 2,369자.
  it("does not hand a bloated recap to a draft when a tighter precedent exists", () => {
    const corpus = [
      bloated("$MNT $BTC $ETH", 20, "x:recap"), // 3 shared of its 23 → 3/23
      { source: "$MNT $ETH staking", target: "스테이킹", itemId: "x:tight" }, // 2 of its 2 → 2/3
    ];
    expect(selectPrecedents("$MNT $BTC $ETH roundup", corpus, 1).map((e) => e.itemId)).toEqual(["x:tight"]);
    expect(selectPrecedents("$MNT $BTC $ETH roundup", corpus, 2).map((e) => e.itemId)).toEqual([
      "x:tight",
      "x:recap",
    ]);
  });

  // Normalizing must not simply mirror the bias onto tiny pairs: `|shared| / |candidate anchors|`
  // would score the single-anchor coincidence 1.0 and this 8-of-10 pair 0.8, inverting the order.
  it("keeps a broad well-covering precedent above a one-anchor coincidence", () => {
    const draft = Array.from({ length: 10 }, (_, i) => `$t${i}`).join(" ");
    const corpus = [
      pair(`$t9 alone`, "우연"), // 1 of its 1 → 1/10
      pair(`${Array.from({ length: 8 }, (_, i) => `$t${i}`).join(" ")} $z1 $z2`, "포괄"), // 8 of its 10 → 8/12
    ];
    expect(selectPrecedents(draft, corpus, 2).map((p) => p.target)).toEqual(["포괄", "우연"]);
  });

  // Equal scores keep input order (V8's stable sort), so two runs over the same TM cannot hand the
  // alignment pass a different worksheet — `selectByAnchors` documents this and callers rely on it.
  it("breaks score ties by input order, stably", () => {
    const corpus = [pair("$MNT first", "첫째"), pair("$MNT second", "둘째"), pair("$MNT third", "셋째")];
    expect(selectPrecedents("$MNT", corpus, 3).map((p) => p.target)).toEqual(["첫째", "둘째", "셋째"]);
    expect(selectPrecedents("$MNT", [...corpus].reverse(), 3).map((p) => p.target)).toEqual([
      "셋째",
      "둘째",
      "첫째",
    ]);
  });

  it("excludes zero-overlap precedents and caps at k", () => {
    const tm = [pair("$MNT a", "가"), pair("$MNT b", "나"), pair("$MNT c", "다"), pair("$ETH d", "라")];
    const got = selectPrecedents("$MNT", tm, 2);
    expect(got).toHaveLength(2);
    expect(got.every((p) => p.source.includes("$MNT"))).toBe(true);
  });

  it("returns nothing when no anchor AND no lexical match above threshold", () => {
    expect(selectPrecedents("plain text no anchors", [pair("$MNT x", "y")], 3)).toEqual([]);
  });

  it("fills an anchorless draft by lexical similarity above the threshold", () => {
    const tm2 = [
      pair("Tokenized stocks trade onchain every weekend", "주말 거래"),
      pair("Hackathon builders gather in Seoul", "해커톤"),
    ];
    // draft has no $/#/@ anchors → anchor picks 0 → lexical fill
    const got = selectPrecedents("Tokenized stocks now trade onchain on weekends", tm2, 3);
    expect(got.map((e) => e.target)).toEqual(["주말 거래"]);
  });

  it("skips a weak lexical match (below threshold) rather than attaching it", () => {
    const tm2 = [pair("Hackathon builders gather in Seoul for the demo day", "해커톤")];
    expect(selectPrecedents("Tokenized stocks trade onchain", tm2, 3)).toEqual([]);
  });

  it("keeps anchor picks first, then lexical-fills the rest without duplicating", () => {
    const tm2 = [
      pair("$MNT staking on Mantle", "스테이킹"), // anchor: shares $mnt
      pair("Staking rewards on Mantle network grow", "리워드"), // lexical: shares mantle/staking/network
      pair("Unrelated hackathon in Seoul", "무관"),
    ];
    const got = selectPrecedents("$MNT staking on Mantle network", tm2, 3);
    expect(got[0].target).toBe("스테이킹"); // anchor pick first
    expect(got.map((e) => e.target)).toContain("리워드"); // lexical fill
    expect(got.map((e) => e.target)).not.toContain("무관");
    expect(new Set(got.map((e) => e.target)).size).toBe(got.length); // no duplicate
  });

  it("drops a partial lexical match that scores below the 0.2 threshold", () => {
    // draft content tokens {tokenized,stocks,liquidity,depth,pricing} (5);
    // pair {hackathon,builders,seoul,demo,stocks,event} (6); share {stocks}=1 → 1/10 = 0.1 < 0.2
    const tm2 = [pair("Hackathon builders Seoul demo stocks event", "무관")];
    expect(selectPrecedents("Tokenized stocks liquidity depth pricing", tm2, 3)).toEqual([]);
  });
});
