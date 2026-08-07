import type { GlossaryEntry } from "./models";

/**
 * A decided term whose source text appeared but whose decided Korean did not.
 *
 * Reported, never thrown: a glossary is guidance with real exceptions (a term inside a quoted
 * English sentence, a rephrasing that drops the noun entirely), so this is a list a human reads,
 * not a gate that fails a run.
 */
export interface GlossaryMiss {
  itemId: string;
  term: string;
  /** What the glossary decided — the entry's `target`, or the term itself for a `keep` rule. */
  expected: string;
}

export interface CheckedTranslation {
  itemId: string;
  sourceText: string;
  koreanText: string;
}

/**
 * Alternatives the entry's own note declares acceptable, so the check does not flag a rendering the
 * glossary itself permits.
 *
 * `real-world assets → 실물자산(RWA)` carries "RWA 단독으로도 사용 가능", and without this every RWA
 * post would be flagged. A noisy check gets switched off, and a check that is off catches nothing —
 * so reading the note is not politeness, it is what keeps the signal usable.
 *
 * Deliberately narrow: only a parenthesised abbreviation inside the target (`실물자산(RWA)` → `RWA`)
 * and the bare target without it. Anything subtler belongs in a human's read of the note, not in a
 * regex that guesses at Korean prose.
 */
function acceptable(expected: string): string[] {
  const out = [expected];
  const paren = /\(([^)]+)\)/.exec(expected);
  if (paren) {
    out.push(paren[1]);
    out.push(expected.replace(/\([^)]*\)/, "").trim());
  }
  return out.filter((s) => s !== "");
}

/**
 * Which decided terms this translation used the source for but did not render as decided.
 *
 * The failure this exists for is invisible one item at a time. `narrative` rendered `이야기` reads
 * perfectly well on its own; it is only wrong against a decision recorded somewhere else, which is
 * precisely what a reviewer cannot hold in their head across a batch of twenty. Measured on
 * 2026-08-07: a batch of nineteen translations drifted from four decided terms this way, and every
 * individual sentence looked fine.
 *
 * Matching is deliberately crude — substring, case-insensitive on the source side. A glossary term
 * is a noun phrase, the source is English prose, and anything cleverer (stemming, word boundaries
 * across `pre-IPO`/`Pre-IPO:`) trades false negatives for false positives. This check's whole value
 * is that a human reads its output, so it is tuned to under-report rather than to be ignored.
 */
export function checkGlossary(t: CheckedTranslation, glossary: GlossaryEntry[]): GlossaryMiss[] {
  const source = t.sourceText.toLowerCase();
  const misses: GlossaryMiss[] = [];
  for (const entry of glossary) {
    if (!source.includes(entry.term.toLowerCase())) continue;
    const expected = entry.rule === "keep" ? entry.term : entry.target;
    if (!expected) continue;
    if (acceptable(expected).some((a) => t.koreanText.includes(a))) continue;
    misses.push({ itemId: t.itemId, term: entry.term, expected });
  }
  return misses;
}
