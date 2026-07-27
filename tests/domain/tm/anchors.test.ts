import { describe, it, expect } from "vitest";
import { extractAnchors, sharedAnchors } from "../../../src/domain/tm/anchors";

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
