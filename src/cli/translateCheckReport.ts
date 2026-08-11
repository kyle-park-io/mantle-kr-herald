import type { GlossaryOverride } from "../domain/translation/glossaryCompliance";
import { opsNotice } from "../shared/opsAlertGrammar";

/**
 * The one thing `translate:check` decides rather than merely prints, pulled out of the script for
 * the same reason `xReconcileReport.ts` exists: a top-level script has no test coverage of its own
 * (running it opens a database connection), so its load-bearing wording has to live somewhere
 * testable. Pure — no clock, no I/O, no `process.env`.
 */

/**
 * Whether a `--notify` run should page the ops room about its published overrides, and the message
 * to send if so. Returns `undefined` when there is nothing to say, so the caller's `if` reads as
 * "is there something to send" rather than repeating the emptiness check — same shape as
 * `retireNotification` (xReconcileReport.ts).
 *
 * Overrides only, never `checkGlossary`'s drift. Drift is a list a human reads before 1차 검수 —
 * the command itself prints "not every line is a defect", and a term inside a quoted English
 * sentence lands there routinely — so paging on it would train the room to ignore this alert, and
 * an alert that is ignored catches nothing. An override is the narrower, actually-actionable claim:
 * our draft used the decided term, a human took it back out after reading it in context, and the
 * thing to reconsider is the glossary entry rather than any translation.
 *
 * Grouped by term, not by item, which is the opposite of the stdout report's grouping and
 * deliberately so. Stdout is read by someone about to open items, so an item is its unit; this is
 * read on a phone by someone deciding whether a glossary entry survives, so the term is. The item
 * COUNT is what carries the weight of that decision — one item is an anecdote, five is a pattern —
 * which is why it is on the line and the item ids are not (they are a `translate:check` away, and
 * a comma-run of ids is what made the first `x:reconcile` alert unreadable on a phone).
 */
export function overrideNotification(overrides: GlossaryOverride[]): string | undefined {
  if (overrides.length === 0) return undefined;

  // Keyed by term alone: the glossary store upserts by term (JsonGlossaryStore.add), so a term has
  // exactly one entry and therefore exactly one `expected`. Items go in a Set rather than a counter
  // because the count claims "how many ITEMS", and two rows for one item — today impossible, one
  // row per itemId in the ledger; tomorrow one ledger change away — would silently inflate the very
  // number the reader is weighing.
  const byTerm = new Map<string, { expected: string; items: Set<string> }>();
  for (const o of overrides) {
    const seen = byTerm.get(o.term) ?? { expected: o.expected, items: new Set<string>() };
    seen.items.add(o.itemId);
    byTerm.set(o.term, seen);
  }

  // Loudest entry first — the one the humans overrode in the most items is the one most likely to
  // be a wrong decision rather than a one-off. Term name breaks ties so the message is stable
  // across runs: an alert whose lines shuffle for no reason reads as new information.
  const lines = [...byTerm.entries()]
    .sort((a, b) => b[1].items.size - a[1].items.size || a[0].localeCompare(b[0]))
    .map(([term, { expected, items }]) => `"${term}" → ${expected} · ${items.size}개 항목`);

  return opsNotice({
    icon: "ℹ",
    title: `translate:check — 발행본이 덮어쓴 용어집 결정 ${byTerm.size}건 (용어집을 다시 볼 후보)`,
    lines,
  });
}
