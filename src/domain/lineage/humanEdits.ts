import type { LineageEntry } from "./models";

/** One before/after pair to diff. Shared with `glossaryMining.ts`, which mines both feeds. */
export interface TextPair {
  itemId: string;
  before: string;
  after: string;
}

/**
 * What a reviewer changed at 1차 검수, for one item's lineage entries in insertion order.
 *
 * Scoped to `stage === "translated"` internally — not left to the caller — because this module is
 * the one place that decides which entries count, and a caller that forgets the filter would start
 * mining 2차 per-channel edits (`SaveRendering`'s `stage: "rendered"`, also constructed with
 * `actor: "human"` in `createDeps.ts`). A 2차 edit has no English source text to anchor a glossary
 * term against — the spec's §6 "No 2차 edits" boundary.
 *
 * The baseline is the last **agent** entry before the first **human** one — not the original machine
 * draft. `translate:align` revises the draft before a reviewer ever sees it (`herald-watch`, every
 * two hours), so diffing against the first draft would credit the reviewer with the alignment
 * pass's work. See docs/superpowers/specs/2026-08-18-human-edit-signal-design.md §3.
 *
 * Returns nothing — rather than an empty-ish pair — when there is no human `translated` entry, no
 * agent entry before it, or the human left the text byte-identical. "The reviewer changed nothing"
 * is a fact about the draft, not an edit to mine.
 */
export function humanEditPairs(entries: LineageEntry[]): TextPair[] {
  const translated = entries.filter((e) => e.stage === "translated");
  const firstHuman = translated.findIndex((e) => e.actor === "human");
  if (firstHuman === -1) return [];

  const baseline = translated.slice(0, firstHuman).filter((e) => e.actor === "agent").at(-1);
  if (baseline === undefined) return [];

  // The "after" side is the contiguous run of human entries starting at `firstHuman` — NOT "the last
  // human entry anywhere". `translate:align` runs inside `herald-watch` every two hours and can land
  // between two human saves: reviewer edits and saves without approving (human), align rewrites it
  // (agent), reviewer approves without touching the text again (a second human entry, carrying the
  // agent's wording). Taking the last human entry in that sequence would pair the align pass's own
  // rewrite in as though the reviewer had chosen it — the exact contamination this module exists to
  // keep out. An agent entry ends the run; a further human entry after it would start a new one, but
  // this module only ever needs the first.
  let end = firstHuman;
  while (end + 1 < translated.length && translated[end + 1].actor === "human") end += 1;
  const after = translated[end];
  if (after.content === baseline.content) return [];

  return [{ itemId: after.itemId, before: baseline.content, after: after.content }];
}
