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
    // Not a style preference — a data contract. `[사진](url)`/`[영상] mp4url` are how the pipeline
    // carries a post's media through translation (see domain/media/sourceMedia.ts), and the label is
    // what lets a reviewer see what a line is without reading a CDN url. Measured 2026-08-07:
    // without this line, 8 of 8 photo-carrying items in one batch came back with `[사진](url)`
    // rewritten to markdown's `![](url)`. `SaveTranslation` puts the label back regardless; this
    // just stops the rewrite happening, and costs one line of prompt. The video marker now carries a
    // url the same agent could "tidy" into `[영상](url)` — a markdown link `linksToPlain` would
    // rewrite, and nothing restores that one — so the paren form is refused by name.
    "**미디어 마커는 그대로 두세요.** `[사진](주소)`·`[영상] 주소`(주소가 없는 `[영상]`도 있습니다)로 " +
      "시작하는 줄은 번역·변형·삭제하지 말고 한 글자도 바꾸지 말고 그 줄 그대로 옮겨 주세요. 마크다운 " +
      "이미지 문법(`![](주소)`)이나 링크 문법(`[영상](주소)`)으로 바꾸지 마세요.",
    "",
  ].join("\n");
}

/** Review-header suffix: an optional reply marker and a source link. Empty when neither field is
 *  present, so a header without them (a Lark item, or an item predating this field) is unchanged.
 *  Shared by the worksheet header here and the review doc (`renderReview`). */
export function replyAndLinkSuffix(isReply?: boolean, refUrl?: string): string {
  let suffix = "";
  if (isReply) suffix += " (댓글·옵셔널)";
  if (refUrl) suffix += ` · [원문](${refUrl})`;
  return suffix;
}

/** Per-item block: content (+ optional ⑥ grounding). No shared context here. */
export function assembleItemBlock(item: ContentItem, grounding?: string): string {
  // Nothing parses the worksheet back, so this label is free-form — it exists only so a reviewer
  // scanning the sheet can tell an Article (thousands of characters) from an ordinary post before
  // opening it. See ContentItem.kind.
  const marker = item.kind === "article" ? " [article]" : "";
  const lines = [`### ${item.id}${marker}${replyAndLinkSuffix(item.isReply, item.refUrl)}`, "원문:", item.text];
  if (grounding && grounding.length > 0) {
    lines.push("⑥ 근거(grounding):", grounding);
  }
  lines.push("번역:", "");
  return lines.join("\n");
}
