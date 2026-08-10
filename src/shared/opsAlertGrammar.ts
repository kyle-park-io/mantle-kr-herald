/**
 * The shape every ops-room message takes, on both sides of a language boundary.
 *
 * `deploy/herald-notify-failure.sh` is bash and this is TypeScript; they cannot share code, only a
 * grammar. Until now they shared only a resemblance — notifyOps's own header says it "deliberately
 * mirrors that script's env contract" — and a resemblance nothing checks is one that drifts until
 * an operator cannot tell which sender is talking. `tests/deploy/opsAlertGrammar.test.ts` reads both
 * files and pins them equal, the same two-files-one-decision coupling `src/deploy/alertMarker.ts`
 * already keeps with the same script.
 *
 * The grammar:
 *
 *     <icon> <title>            plain — must stay readable on a narrow phone
 *     <pre>line
 *     line</pre>                monospace — the reports these commands print are column-aligned
 *     ↳ <pointer>               where to read the rest (failure alerts only)
 */

/**
 * For `parse_mode: "HTML"`, which needs only these three — the reason the repo chose HTML over
 * MarkdownV2, whose 18 characters include `.`, `(`, `)` and `-`
 * (`src/domain/formatting/emitters/telegram.ts:29`).
 *
 * `&` first, or the ampersands this introduces are escaped again and the reader sees `&amp;lt;`.
 * The plain-text retry in `notifyOps.ts` undoes this in the REVERSE order (`&lt;`/`&gt;` before
 * `&amp;`) for exactly the same reason run backwards: a source string that already contained a
 * literal `&lt;` becomes `&amp;lt;` here, and only the reverse order gives it back unchanged.
 */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One non-failure ops notice, in the shared grammar. `icon` is `"ℹ"` for something worth noting and
 * `"⚠"` for something worth a second look — `deploy/herald-notify-failure.sh` only ever sends `⚠`,
 * since everything it reports is a failure; this side needed the calmer icon too, since its first
 * caller (`x:reconcile` retiring translations) is not one.
 */
export function opsNotice(opts: { icon: "ℹ" | "⚠"; title: string; lines?: string[] }): string {
  const head = `${opts.icon} ${escapeTelegramHtml(opts.title)}`;
  if (!opts.lines || opts.lines.length === 0) return head;
  return `${head}\n<pre>${opts.lines.map(escapeTelegramHtml).join("\n")}</pre>`;
}
