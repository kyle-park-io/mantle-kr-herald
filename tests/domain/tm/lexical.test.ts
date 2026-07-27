import { describe, it, expect } from "vitest";
import { lexicalSimilarity } from "../../../src/domain/tm/lexical";

describe("lexicalSimilarity", () => {
  it("is 1 for identical content", () => {
    expect(lexicalSimilarity("tokenized stocks trade onchain", "tokenized stocks trade onchain")).toBe(1);
  });

  it("is 0 for disjoint content", () => {
    expect(lexicalSimilarity("tokenized stocks liquidity", "hackathon builders seoul")).toBe(0);
  });

  it("computes the exact Jaccard for partial overlap", () => {
    // A={tokenized,stocks,trade} B={tokenized,stocks,weekend} → inter 2, union 4 → 0.5
    expect(lexicalSimilarity("tokenized stocks trade", "tokenized stocks weekend")).toBe(0.5);
  });

  it("drops stopwords and <=2-char tokens (texts differing only in those score 1)", () => {
    expect(lexicalSimilarity("the tokenized stocks", "tokenized stocks on it")).toBe(1);
  });

  it("is 0 when one side has no content tokens", () => {
    expect(lexicalSimilarity("the a on to", "tokenized stocks")).toBe(0);
  });

  it("is 0 when both sides have no content tokens", () => {
    expect(lexicalSimilarity("the a on to", "is it we no")).toBe(0);
  });
});
