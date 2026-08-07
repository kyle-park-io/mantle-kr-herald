import { describe, expect, it } from "vitest";
import { checkGlossary, type GlossaryMiss } from "../../src/domain/translation/glossaryCompliance";
import type { GlossaryEntry } from "../../src/domain/translation/models";

const g = (term: string, target?: string, rule: GlossaryEntry["rule"] = "translate"): GlossaryEntry => ({
  term,
  rule,
  target,
  updatedAt: "2026-08-07",
});

const terms = (misses: GlossaryMiss[]) => misses.map((m) => m.term);

describe("checkGlossary", () => {
  it("reports a decided term the translation did not use", () => {
    // The real one: `narrative` was rendered 이야기 instead of the decided 내러티브. Reading that
    // sentence alone, nothing looks wrong — which is exactly why a person does not catch it.
    const misses = checkGlossary(
      { itemId: "x:1", sourceText: "moved RWAs from narrative to reality", koreanText: "RWA를 이야기에서 현실로 옮겼습니다" },
      [g("narrative", "내러티브", "transliterate")],
    );
    expect(terms(misses)).toEqual(["narrative"]);
    expect(misses[0].expected).toBe("내러티브");
  });

  it("says nothing when the decided term was used", () => {
    expect(
      checkGlossary(
        { itemId: "x:1", sourceText: "narrative to reality", koreanText: "내러티브에서 현실로" },
        [g("narrative", "내러티브", "transliterate")],
      ),
    ).toEqual([]);
  });

  it("ignores a term the source never used", () => {
    // Every glossary entry is checked against every translation, so the common case is "not
    // relevant here" — that must be silent, or the report is unreadable.
    expect(
      checkGlossary({ itemId: "x:1", sourceText: "a post about staking", koreanText: "스테이킹 게시물" }, [
        g("narrative", "내러티브", "transliterate"),
      ]),
    ).toEqual([]);
  });

  it("matches the source term case-insensitively", () => {
    // Source text is prose: "Private credit:" in a list, "private credit" mid-sentence.
    expect(
      terms(checkGlossary({ itemId: "x:1", sourceText: "Private credit: @maplefinance", koreanText: "크레딧 자산" }, [
        g("private credit", "사모 크레딧"),
      ])),
    ).toEqual(["private credit"]);
  });

  it("accepts any alternative the entry's note explicitly allows", () => {
    // `real-world assets → 실물자산(RWA)` has a note saying "RWA 단독으로도 사용 가능". A checker that
    // ignored that would flag almost every RWA post — noise that gets the whole check switched off.
    const entry: GlossaryEntry = {
      term: "real-world assets",
      rule: "translate",
      target: "실물자산(RWA)",
      note: "약어 병기 형태로 표기. RWA 단독으로도 사용 가능.",
      updatedAt: "2026-07-21",
    };
    expect(checkGlossary({ itemId: "x:1", sourceText: "real-world assets grew", koreanText: "RWA가 늘었습니다" }, [entry])).toEqual([]);
  });

  it("expects the term itself when the rule is keep", () => {
    // `keep` entries carry no target — the decision is "do not translate this at all".
    expect(
      terms(checkGlossary({ itemId: "x:1", sourceText: "TVL rose", koreanText: "예치총액이 늘었습니다" }, [g("TVL", undefined, "keep")])),
    ).toEqual(["TVL"]);
    expect(checkGlossary({ itemId: "x:1", sourceText: "TVL rose", koreanText: "TVL이 늘었습니다" }, [g("TVL", undefined, "keep")])).toEqual([]);
  });

  it("reports every missed term on one item, not just the first", () => {
    const misses = checkGlossary(
      { itemId: "x:1", sourceText: "Money markets and Commodities", koreanText: "단기금융과 상품" },
      [g("Money markets", "머니마켓", "transliterate"), g("Commodities", "원자재")],
    );
    expect(terms(misses)).toEqual(["Money markets", "Commodities"]);
  });
});
