import { describe, it, expect } from "vitest";
import { assembleRefinementWorksheet } from "../../../src/domain/formatting/refinementWorksheet";

describe("assembleRefinementWorksheet", () => {
  it("emits a header and one block per draft with 초안 and an empty 보정 slot", () => {
    const out = assembleRefinementWorksheet(
      [
        { itemId: "x:1", type: "x", channel: "x", draft: "X 초안 텍스트" },
        { itemId: "x:1", type: "kol", channel: "telegram", draft: "*텔레그램*" },
      ],
      [],
    );
    expect(out).toContain("보정");
    expect(out).toContain("## x:1 · X · x");
    expect(out).toContain("X 초안 텍스트");
    expect(out).toContain("## x:1 · KOL · telegram");
    expect(out).toContain("초안:");
    expect(out.trimEnd().endsWith("보정:")).toBe(true);
  });
});
