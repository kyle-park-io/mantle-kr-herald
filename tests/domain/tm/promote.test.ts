import { describe, it, expect } from "vitest";
import { acceptedRecords } from "../../../src/domain/tm/promote";
import type { ProposedRecord } from "../../../src/domain/tm/pairsReview";

const rec = (koId: string, accept: boolean): ProposedRecord => ({
  enId: "x:e", koId, score: 2, shared: ["$mnt", "#mantle"], source: "s", target: "t", accept,
});

describe("acceptedRecords", () => {
  it("keeps accept:true, drops accept:false", () => {
    const got = acceptedRecords([rec("x:1", true), rec("x:2", false), rec("x:3", true)]);
    expect(got.map((r) => r.koId)).toEqual(["x:1", "x:3"]);
  });

  it("treats a missing accept flag as accepted", () => {
    const partial = { enId: "x:e", koId: "x:9", score: 2, shared: [], source: "s", target: "t" } as ProposedRecord;
    expect(acceptedRecords([partial])).toHaveLength(1);
  });
});
