import type { Translation } from "../translation/models";

/** Turn an itemId ("x:100") into a safe .md filename ("x-100.md"). */
export function safeFileName(itemId: string): string {
  return `${itemId.replace(/[^a-zA-Z0-9._-]/g, "-")}.md`;
}

/** First ~6 alphanumeric words of the source text, dash-joined (URLs & punctuation dropped). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 50);
}

/** Descriptive Drive filename "<date>-<slug>-<id>.md" so review folders are browsable
 *  (date = approved day if approved, else translated day; slug omitted when empty). */
export function publishFileName(t: Translation): string {
  const date = (t.approvedAt ?? t.translatedAt).slice(0, 10);
  const slug = slugify(t.sourceText);
  const id = t.itemId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${[date, slug, id].filter(Boolean).join("-")}.md`;
}

/** Review doc: source + Korean side by side (for 1차 검수). */
export function renderReview(t: Translation): string {
  return `# ${t.itemId}\n\n## 원문 (source)\n\n${t.sourceText}\n\n## 한글 (Korean)\n\n${t.koreanText}\n`;
}

/** Approved doc: Korean text only (final). */
export function renderApproved(t: Translation): string {
  return `${t.koreanText}\n`;
}
