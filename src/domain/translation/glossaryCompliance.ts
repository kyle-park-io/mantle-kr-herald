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
/** Escape a glossary term for use inside a RegExp — terms contain `$`, `(`, `.`, `-`. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a term really occurs in the source: as prose, or only inside an `@handle`.
 *
 * Two filters, each removing a false-positive class measured on a real run of 14 translations:
 *
 * 1. **Word boundaries for ASCII terms.** `UR` (Mantle's smart-money app) matched inside "yo*ur*",
 *    "capt*ure*" and "s*ure*" — six false positives in one run, the largest single source of noise.
 *    Applied only to terms that are wholly ASCII: a Korean or mixed term has no word boundary in
 *    the JS sense, and `\b` around one matches nothing.
 * 2. **Mentions are not prose.** `@Fluxion_network` is a handle, and style-guide §11 keeps handles
 *    verbatim, so the decided Korean does not apply there — without this, every partner post is
 *    flagged. Only suppressed when *every* occurrence is inside a mention: 12번's source says
 *    "went live on Fluxion and @MerchantMoe_xyz", a bare name in running text, and that one is a
 *    genuine finding this must not swallow.
 */
function occursAsProse(sourceText: string, term: string): boolean {
  const ascii = /^[\x20-\x7E]+$/.test(term);
  const body = escape(term);
  const pattern = ascii ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body;
  const re = new RegExp(pattern, "gi");
  for (const m of sourceText.matchAll(re)) {
    const start = m.index ?? 0;
    // Walk back over the handle's own characters to see whether an `@` introduces this occurrence.
    let i = start - 1;
    while (i >= 0 && /[A-Za-z0-9_]/.test(sourceText[i])) i--;
    if (sourceText[i] !== "@") return true; // at least one plain-prose occurrence
  }
  return false;
}

export function checkGlossary(t: CheckedTranslation, glossary: GlossaryEntry[]): GlossaryMiss[] {
  const misses: GlossaryMiss[] = [];
  for (const entry of glossary) {
    if (!occursAsProse(t.sourceText, entry.term)) continue;
    const expected = entry.rule === "keep" ? entry.term : entry.target;
    if (!expected) continue;
    if (acceptable(expected).some((a) => t.koreanText.includes(a))) continue;
    misses.push({ itemId: t.itemId, term: entry.term, expected });
  }
  return misses;
}

/**
 * A decided term our draft rendered correctly, but that the published post — the human's own
 * rewrite — dropped anyway.
 *
 * This is not `checkGlossary` run twice: it is a statement about the glossary itself, not about a
 * single translation. `checkGlossary` catches a draft that missed a decision; this catches a
 * decision the humans keep overriding once it reaches their hands, which is a signal the glossary
 * entry may be wrong rather than that anyone made a mistake. Reported, never thrown, for the same
 * reason as `checkGlossary`.
 *
 * Deliberately silent when our own draft never used the decided term either (`checkGlossary` already
 * reports that as a miss) and when there is no `publishedText` yet — a row nobody has captured a
 * published copy for is not evidence of anything.
 */
export interface GlossaryOverride {
  itemId: string;
  term: string;
  /** What the glossary decided — the entry's `target`, or the term itself for a `keep` rule. */
  expected: string;
}

export function checkPublishedOverrides(
  t: { itemId: string; sourceText: string; koreanText: string; publishedText?: string },
  glossary: GlossaryEntry[],
): GlossaryOverride[] {
  if (!t.publishedText) return [];
  const overrides: GlossaryOverride[] = [];
  for (const entry of glossary) {
    if (!occursAsProse(t.sourceText, entry.term)) continue;
    const expected = entry.rule === "keep" ? entry.term : entry.target;
    if (!expected) continue;
    const forms = acceptable(expected);
    if (!forms.some((a) => t.koreanText.includes(a))) continue; // our draft never used it either
    if (forms.some((a) => t.publishedText!.includes(a))) continue; // the human kept it
    overrides.push({ itemId: t.itemId, term: entry.term, expected });
  }
  return overrides;
}
