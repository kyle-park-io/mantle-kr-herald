import { describe, it, expect } from "vitest";
import {
  assembleVariantBlock,
  assembleTypeSection,
  assembleConversionWorksheet,
  typeLabel,
} from "../../../src/domain/conversion/promptAssembler";
import type { GlossaryEntry, Locale, FewShotExample } from "../../../src/domain/translation/models";

const locale: Locale = {
  dateFormat: "YYYY년 M월 D일", numberFormat: "천 단위 콤마",
  currency: "USD", unit: "미터법", honorific: "합니다체",
};
const glossary: GlossaryEntry[] = [{ term: "Mainnet", rule: "transliterate", target: "메인넷", updatedAt: "2026-01-01" }];
const fewShots: FewShotExample[] = [{ source: "승인된 한글", target: "변환된 카피", itemId: "x:1" }];

describe("typeLabel", () => {
  it("maps types to display labels", () => {
    expect(typeLabel("x")).toBe("X");
    expect(typeLabel("kol")).toBe("KOL");
    expect(typeLabel("pr")).toBe("PR");
  });
});

describe("assembleVariantBlock", () => {
  it("emits the id, 승인본 with the Korean, and an empty 변환 slot", () => {
    const out = assembleVariantBlock("x:100", "안녕 맨틀");
    expect(out).toContain("### x:100");
    expect(out).toContain("승인본:");
    expect(out).toContain("안녕 맨틀");
    expect(out.trimEnd().endsWith("변환:")).toBe(true);
  });
});

describe("assembleTypeSection", () => {
  it("includes the type label, guide, glossary, locale, few-shots, and every item block", () => {
    const out = assembleTypeSection({
      type: "x", guideText: "X 유형 역할·스타일", glossary, locale, fewShots,
      items: [{ itemId: "x:1", sourceKorean: "원문 카피" }, { itemId: "x:2", sourceKorean: "다른 카피" }],
    });
    expect(out).toContain("## 유형: X");
    expect(out).toContain("X 유형 역할·스타일");
    expect(out).toContain("Mainnet → transliterate: 메인넷");
    expect(out).toContain("합니다체");
    expect(out).toContain("승인된 한글");   // few-shot source
    expect(out).toContain("변환된 카피");   // few-shot target
    expect(out).toContain("### x:1");
    expect(out).toContain("### x:2");
  });
});

describe("assembleConversionWorksheet", () => {
  it("prefixes a header and joins sections", () => {
    const out = assembleConversionWorksheet(["## 유형: X\n...", "## 유형: KOL\n..."]);
    expect(out).toContain("아이템 변환");
    expect(out.indexOf("유형: X")).toBeLessThan(out.indexOf("유형: KOL"));
  });
});
