import { describe, it, expect } from "vitest";
import { proposePairs, type PairOptions } from "../../../src/domain/tm/pairing";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const opts: PairOptions = { windowDays: 14, minAnchors: 2 };

function en(id: string, createdAt: string, text: string): ContentItem {
  return { id, source: "x", text, createdAt };
}
function ko(id: string, createdAt: string, text: string): ContentItem {
  return { id, source: "x", text, createdAt };
}

describe("proposePairs", () => {
  it("pairs a KO post to the EN post it translates (≥minAnchors, within window, KO after EN)", () => {
    const enItems = [en("x:1", "2026-07-10T00:00:00Z", "$MNT rewards live #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT 리워드 시작 #Mantle")];
    const pairs = proposePairs(enItems, koItems, opts);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ enId: "x:1", koId: "x:100", score: 2 });
    expect(pairs[0].shared.sort()).toEqual(["#mantle", "$mnt"]);
    expect(pairs[0].source).toContain("rewards");
    expect(pairs[0].target).toContain("리워드");
  });

  it("rejects a candidate sharing fewer than minAnchors", () => {
    const enItems = [en("x:1", "2026-07-10T00:00:00Z", "$MNT only")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT 만")]; // shares $mnt only → 1 < 2
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("rejects a KO post published BEFORE the EN post", () => {
    const enItems = [en("x:1", "2026-07-12T00:00:00Z", "$MNT #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle")]; // gap negative
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("rejects a candidate outside the window", () => {
    const enItems = [en("x:1", "2026-06-01T00:00:00Z", "$MNT #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle")]; // >14 days
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("chooses the highest-anchor EN candidate", () => {
    const enItems = [
      en("x:1", "2026-07-10T00:00:00Z", "$MNT #Mantle"),
      en("x:2", "2026-07-10T06:00:00Z", "$MNT #Mantle @Bybit_Official"),
    ];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle @Bybit_Official 소식")];
    const pairs = proposePairs(enItems, koItems, opts);
    expect(pairs[0].enId).toBe("x:2");
    expect(pairs[0].score).toBe(3);
  });
});
