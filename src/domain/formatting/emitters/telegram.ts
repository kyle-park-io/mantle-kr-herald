import { BOLD, MD_LINK, flattenPostBoundaries, linksToLabel, linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/** sendMessage's text limit, counted after entity parsing. https://core.telegram.org/bots/api */
export const TELEGRAM_MAX = 4096;

function single(text: string, visibleLength: number): EmitResult {
  const overLimit = visibleLength > TELEGRAM_MAX;
  return {
    segments: [{ text, length: visibleLength, limit: TELEGRAM_MAX, overLimit }],
    warnings: overLimit
      ? [`${visibleLength}/${TELEGRAM_MAX}자 (${visibleLength - TELEGRAM_MAX} 초과) — 나누어 보내야 합니다`]
      : [],
  };
}

/**
 * Telegram's API docs put markdown parsing on each client, and its own bug tracker records client
 * formatting diverging from the Bot API's. Nothing is documented to render on the paste path, so
 * emit plain text — `*bold*` here would show up as literal asterisks.
 */
export function emitTelegramPaste(canonical: string): EmitResult {
  const flattened = flattenPostBoundaries(canonical);
  const text = linksToPlain(stripBold(flattened));
  return single(text, [...text].length);
}

/**
 * For `sendMessage` with `parse_mode: "HTML"` — never MarkdownV2, which requires escaping 18
 * characters including `.`, `(`, `)` and `-`, all of which saturate Korean prose. HTML mode needs
 * only `&`, `<` and `>`.
 *
 * Escaping runs before tag insertion. That is safe because HTML escaping never introduces `*`,
 * `[`, `]`, `(` or `)`, and it is necessary so that an `&` inside a URL query string is escaped
 * too.
 */
export function emitTelegramBot(canonical: string): EmitResult {
  const flattened = flattenPostBoundaries(canonical);
  const escaped = flattened
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // The href is an attribute value, so it additionally needs `"` escaped — unlike the label,
  // which sits in element content. A function replacer keeps that escaping off the label.
  const html = escaped
    .replace(BOLD, "<b>$1</b>")
    .replace(MD_LINK, (_match, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
  // "after entities parsing" means the text the reader sees: no markup, no href.
  const visible = [...stripBold(linksToLabel(flattened))].length;
  return single(html, visible);
}
