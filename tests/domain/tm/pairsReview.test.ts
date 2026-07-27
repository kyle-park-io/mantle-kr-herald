import { describe, it, expect } from "vitest";
import { toProposedRecords, renderPairsReview } from "../../../src/domain/tm/pairsReview";
import type { ProposedPair } from "../../../src/domain/tm/pairing";

const pair: ProposedPair = {
  enId: "x:1", koId: "x:100", score: 2, shared: ["$mnt", "#mantle"],
  source: "$MNT rewards #Mantle", target: "$MNT 리워드 #Mantle",
};

describe("toProposedRecords", () => {
  it("defaults every record to accept:true", () => {
    expect(toProposedRecords([pair])).toEqual([{ ...pair, accept: true }]);
  });
});

describe("renderPairsReview", () => {
  it("shows the ids, score, and both texts", () => {
    const md = renderPairsReview([pair]);
    expect(md).toContain("x:1");
    expect(md).toContain("x:100");
    expect(md).toContain("score 2");
    expect(md).toContain("$MNT rewards #Mantle");
    expect(md).toContain("$MNT 리워드 #Mantle");
  });

  it("handles the empty case", () => {
    expect(renderPairsReview([])).toContain("제안된 쌍 없음");
  });
});
