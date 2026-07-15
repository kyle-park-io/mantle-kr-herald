import type { GlossaryEntry, Locale, FewShotExample } from "../translation/models";
import { renderGlossaryEntry, renderLocale } from "../translation/promptAssembler";
import { typeLabel, type ConversionType } from "./models";

// Re-exported so callers can import both the assembler and the label helper
// from this module (the test suite for §5 expects `typeLabel` here too).
export { typeLabel };

/** Per-item block: approved Korean in, empty 변환 slot out. No shared context here. */
export function assembleVariantBlock(itemId: string, sourceKorean: string): string {
  return [`### ${itemId}`, "승인본:", sourceKorean, "변환:", ""].join("\n");
}

export interface TypeSectionInput {
  type: ConversionType;
  guideText: string;
  glossary: GlossaryEntry[];
  locale: Locale;
  fewShots: FewShotExample[];
  items: { itemId: string; sourceKorean: string }[];
}

/** One type's full section: role/style + glossary + locale + few-shots, then item blocks. */
export function assembleTypeSection(input: TypeSectionInput): string {
  const label = typeLabel(input.type);
  const glossary = input.glossary.map(renderGlossaryEntry).join("\n");
  const fewShots = input.fewShots.map((f) => `- 원문: ${f.source}\n  변환: ${f.target}`).join("\n");
  const blocks = input.items.map((i) => assembleVariantBlock(i.itemId, i.sourceKorean));
  return [
    `## 유형: ${label}`,
    "",
    "### 역할·스타일",
    input.guideText,
    "",
    "### 용어집 (Glossary)",
    glossary,
    "",
    "### 로케일",
    renderLocale(input.locale),
    "",
    "### 예시 (Few-shot)",
    fewShots,
    "",
    "---",
    `아래 각 아이템의 \`승인본:\`을 위 규칙에 따라 ${label} 유형에 맞게 변환해 \`변환:\` 아래에 채워 주세요.`,
    "",
    ...blocks,
  ].join("\n");
}

export function assembleConversionWorksheet(sections: string[]): string {
  return ["# Mantle KR 아이템 변환 작업", "", ...sections].join("\n");
}
