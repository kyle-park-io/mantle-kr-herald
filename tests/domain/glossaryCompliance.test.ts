import { describe, expect, it } from "vitest";
import { checkGlossary, checkPublishedOverrides, type GlossaryMiss } from "../../src/domain/translation/glossaryCompliance";
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

  it("does not match a short term inside a longer English word", () => {
    // Measured against production: `UR` (Mantle's smart-money app) matched inside "yo*ur*",
    // "capt*ure*", "s*ure*" and produced six false positives in one run — the single largest source
    // of noise, and the kind that gets a report ignored.
    expect(
      checkGlossary({ itemId: "x:1", sourceText: "Access that once ran through your brokers", koreanText: "브로커" }, [
        g("UR", undefined, "keep"),
      ]),
    ).toEqual([]);
  });

  it("still matches a short term standing on its own", () => {
    expect(
      terms(checkGlossary({ itemId: "x:1", sourceText: "UR is live", koreanText: "앱이 출시됐습니다" }, [g("UR", undefined, "keep")])),
    ).toEqual(["UR"]);
  });

  it("ignores a name that appears only inside an @mention", () => {
    // `@Fluxion_network` is a handle, and style-guide §11 keeps handles verbatim — demanding the
    // decided Korean there would flag every partner post. The decision applies to prose, not to the
    // account tag.
    expect(
      checkGlossary(
        { itemId: "x:1", sourceText: "trade on @Fluxion_network today", koreanText: "@Fluxion_network에서 거래" },
        [g("Fluxion", "플럭션", "transliterate")],
      ),
    ).toEqual([]);
  });

  it("still reports a name used as prose alongside its mention", () => {
    // The real one: 12번's source says "went live on Fluxion and @MerchantMoe_xyz" — a bare
    // `Fluxion` in running text, which is exactly where the decided rendering applies. Suppressing
    // the mention case must not suppress this one.
    expect(
      terms(
        checkGlossary(
          { itemId: "x:1", sourceText: "live on Fluxion and @Fluxion_network", koreanText: "Fluxion에서 시작" },
          [g("Fluxion", "플럭션", "transliterate")],
        ),
      ),
    ).toEqual(["Fluxion"]);
  });

  it("reports every missed term on one item, not just the first", () => {
    const misses = checkGlossary(
      { itemId: "x:1", sourceText: "Money markets and Commodities", koreanText: "단기금융과 상품" },
      [g("Money markets", "머니마켓", "transliterate"), g("Commodities", "원자재")],
    );
    expect(terms(misses)).toEqual(["Money markets", "Commodities"]);
  });
});

describe("checkPublishedOverrides", () => {
  const glossary = [{ term: "narrative", rule: "translate" as const, target: "내러티브", updatedAt: "2026-07-14" }];

  it("reports a decided term our draft used and the published post dropped", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
      publishedText: "이야기가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([{ itemId: "x:1", term: "narrative", expected: "내러티브" }]);
  });

  it("reports nothing when the published post kept the decided term", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
      publishedText: "내러티브가 달라지고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when our draft never used the decided term either", () => {
    // That is a plain drift, which checkGlossary already reports. Reporting it here too would
    // double-count it and make the override list untrustworthy as a signal about the glossary.
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "이야기가 바뀌고 있습니다",
      publishedText: "이야기가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when the term never occurs as prose in the source", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "ask @narrative_xyz about it",
      koreanText: "내러티브",
      publishedText: "이야기",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when there is no published text yet", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });
});
