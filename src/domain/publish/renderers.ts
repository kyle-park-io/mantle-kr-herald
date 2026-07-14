import type { Translation } from "../translation/models";

/** Turn an itemId ("x:100") into a safe .md filename ("x-100.md"). */
export function safeFileName(itemId: string): string {
  return `${itemId.replace(/[^a-zA-Z0-9._-]/g, "-")}.md`;
}

/** Review doc: source + Korean side by side (for 1차 검수). */
export function renderReview(t: Translation): string {
  return `# ${t.itemId}\n\n## 원문 (source)\n\n${t.sourceText}\n\n## 한글 (Korean)\n\n${t.koreanText}\n`;
}

/** Approved doc: Korean text only (final). */
export function renderApproved(t: Translation): string {
  return `${t.koreanText}\n`;
}
