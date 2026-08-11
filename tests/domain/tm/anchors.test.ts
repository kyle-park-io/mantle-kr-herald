import { describe, it, expect } from "vitest";
import { anchorSimilarity, extractAnchors, sharedAnchors } from "../../../src/domain/tm/anchors";

describe("extractAnchors", () => {
  it("pulls cashtags, hashtags and mentions, lowercased", () => {
    const got = extractAnchors("Big for $MNT with @Bybit_Official #Mantle");
    expect(got.sort()).toEqual(["#mantle", "$mnt", "@bybit_official"]);
  });

  it("dedupes case-insensitively", () => {
    expect(extractAnchors("$MNT $mnt $Mnt")).toEqual(["$mnt"]);
  });

  it("returns [] when there are no anchors", () => {
    expect(extractAnchors("plain text, no tags here")).toEqual([]);
  });
});

describe("sharedAnchors", () => {
  it("returns the intersection", () => {
    expect(sharedAnchors(["$mnt", "#mantle", "@a"], ["#mantle", "@a", "@b"])).toEqual(["#mantle", "@a"]);
  });

  it("is empty when nothing overlaps", () => {
    expect(sharedAnchors(["$mnt"], ["#mantle"])).toEqual([]);
  });
});

describe("anchorSimilarity", () => {
  it("is 1 for identical anchor sets", () => {
    expect(anchorSimilarity(["$mnt", "#mantle"], ["#mantle", "$mnt"])).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(anchorSimilarity(["$mnt"], ["#mantle"])).toBe(0);
  });

  it("is 0 (never NaN) when either side is empty", () => {
    expect(anchorSimilarity([], ["$mnt"])).toBe(0);
    expect(anchorSimilarity(["$mnt"], [])).toBe(0);
    expect(anchorSimilarity([], [])).toBe(0);
  });

  // Pins the denominator as the UNION, not the sum and not either side alone: 2 shared of
  // {a,b,c} ∪ {b,c,d} = 4 distinct → 0.5. |a|+|b| would give 2/6, |candidate| would give 2/3.
  it("divides by the union of the two sets", () => {
    expect(anchorSimilarity(["$a", "$b", "$c"], ["$b", "$c", "$d"])).toBe(0.5);
  });

  it("is symmetric", () => {
    const a = ["$a", "$b", "$c", "$d"];
    const b = ["$c", "$d"];
    expect(anchorSimilarity(a, b)).toBe(0.5);
    expect(anchorSimilarity(b, a)).toBe(0.5);
  });

  // The whole point of the measure: absolute overlap is not relevance. The wide candidate shares
  // three anchors and the narrow one only two, yet the narrow one is the better precedent.
  it("scores a tight small overlap above a larger overlap from a bloated set", () => {
    const target = ["$a", "$b", "$c"];
    const bloated = ["$a", "$b", "$c", ...Array.from({ length: 37 }, (_, i) => `$x${i}`)]; // 3 of 40
    const tight = ["$a", "$b"]; // 2 of 2
    expect(anchorSimilarity(bloated, target)).toBeCloseTo(0.075, 10); // 3 / 40
    expect(anchorSimilarity(tight, target)).toBeCloseTo(2 / 3, 10);
    expect(anchorSimilarity(tight, target)).toBeGreaterThan(anchorSimilarity(bloated, target));
  });

  // …but not by flipping the bias the other way, which is what `|shared| / |candidate|` would do:
  // that ratio scores the 1-of-1 at 1.0 and the 8-of-10 at 0.8.
  it("still ranks a broad, well-covering candidate above a one-anchor coincidence", () => {
    const target = Array.from({ length: 10 }, (_, i) => `$t${i}`);
    const covering = [...target.slice(0, 8), "$z1", "$z2"]; // 8 of its 10
    const coincidence = ["$t0"]; // 1 of its 1
    expect(anchorSimilarity(covering, target)).toBeCloseTo(8 / 12, 10);
    expect(anchorSimilarity(coincidence, target)).toBeCloseTo(0.1, 10);
    expect(anchorSimilarity(covering, target)).toBeGreaterThan(anchorSimilarity(coincidence, target));
  });
});
