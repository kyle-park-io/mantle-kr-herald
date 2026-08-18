// src/domain/kol/names.ts

/**
 * Loosely folds a KOL name so two tabs' spellings of the same person can be compared, without
 * pretending the two are the same string. On live data they disagree only by case and incidental
 * whitespace (`"Enjoy hobby"` vs `"Enjoyhobby"`, `"CEK"` vs `"Cek"`), never by substance, so this
 * is deliberately narrow: it does not fuzzy-match, transliterate, or strip punctuation. A pair that
 * still disagrees after this is a genuinely different name, not a formatting accident.
 *
 * Two callers share it, and it must stay one function: `SweepKolQuarter.compareAgainstContract`
 * joins the contract tab's names to the roster's `sheetLabel` with it (and reports what it cannot
 * match rather than guessing), and `rosterMigration` uses it as the *fallback* join key behind the
 * Telegram handle — defensible there only because that migration previews every proposed placement
 * and a human reads them before `--yes` writes anything. Two implementations would let those two
 * judgements drift apart silently.
 */
export function normalizeKolName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}
