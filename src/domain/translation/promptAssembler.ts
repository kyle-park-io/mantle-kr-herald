import type { ContentItem } from "./contentItem";
import type { GlossaryEntry, Locale, SharedContext } from "./models";

export function renderGlossaryEntry(e: GlossaryEntry): string {
  const target = e.target ? `: ${e.target}` : "";
  const note = e.note ? ` (${e.note})` : "";
  return `- ${e.term} → ${e.rule}${target}${note}`;
}

export function renderLocale(l: Locale): string {
  return [
    `- 날짜: ${l.dateFormat}`,
    `- 숫자: ${l.numberFormat}`,
    `- 통화: ${l.currency}`,
    `- 단위: ${l.unit}`,
    `- 존대: ${l.honorific}`,
  ].join("\n");
}

/** Element ①②③④⑤ assembled once per batch (never repeated per item). */
export function assembleSharedContext(ctx: SharedContext): string {
  const glossary = ctx.glossary.map(renderGlossaryEntry).join("\n");
  const fewShots = ctx.fewShots
    .map((f) => `- EN: ${f.source}\n  KO: ${f.target}`)
    .join("\n");
  return [
    "# Mantle KR 번역 작업",
    "",
    "## ① 역할",
    ctx.role,
    "",
    "## ② 용어집 (Glossary)",
    glossary,
    "",
    "## ③ 스타일 가이드",
    ctx.styleGuide.text,
    "",
    "## ④ 로케일",
    renderLocale(ctx.locale),
    "",
    "## ⑤ 예시 (Few-shot)",
    fewShots,
    "",
    "---",
    "아래 각 아이템의 `원문:`을 위 규칙에 따라 번역해 `번역:` 아래에 채워 주세요.",
    "",
  ].join("\n");
}

/** Per-item block: content (+ optional ⑥ grounding). No shared context here. */
export function assembleItemBlock(item: ContentItem, grounding?: string): string {
  const lines = [`### ${item.id}`, "원문:", item.text];
  if (grounding && grounding.length > 0) {
    lines.push("⑥ 근거(grounding):", grounding);
  }
  lines.push("번역:", "");
  return lines.join("\n");
}
