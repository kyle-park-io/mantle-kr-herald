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

  it("orders channel constraint bullets by ALL_CHANNELS, not by draft/approval order", () => {
    const out = assembleRefinementWorksheet(
      [
        { itemId: "x:1", type: "pr", channel: "pr_mail", draft: "메일" },
        { itemId: "x:1", type: "kol", channel: "telegram", draft: "텔레그램" },
        { itemId: "x:1", type: "x", channel: "x", draft: "엑스" },
      ],
      [],
    );
    const constraints = out.split("## 채널 제약")[1].split("\n\n")[0];
    expect(constraints.indexOf("- x:")).toBeLessThan(constraints.indexOf("- telegram:"));
    expect(constraints.indexOf("- telegram:")).toBeLessThan(constraints.indexOf("- pr_mail:"));
  });
});
