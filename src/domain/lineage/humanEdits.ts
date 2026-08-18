import type { LineageEntry } from "./models";

/** One before/after pair to diff. Shared with `glossaryMining.ts`, which mines both feeds. */
export interface TextPair {
  itemId: string;
  before: string;
  after: string;
}

/**
 * What a reviewer changed at 1차 검수, for one item's `translated` entries in insertion order.
 *
 * The baseline is the last **agent** entry before the first **human** one — not the original machine
 * draft. `translate:align` revises the draft before a reviewer ever sees it (`herald-watch`, every
 * two hours), so diffing against the first draft would credit the reviewer with the alignment
 * pass's work. See docs/superpowers/specs/2026-08-18-human-edit-signal-design.md §3.
 *
 * Returns nothing — rather than an empty-ish pair — when there is no human entry, no agent entry
 * before it, or the human left the text byte-identical. "The reviewer changed nothing" is a fact
 * about the draft, not an edit to mine.
 */
export function humanEditPairs(entries: LineageEntry[]): TextPair[] {
  const firstHuman = entries.findIndex((e) => e.actor === "human");
  if (firstHuman === -1) return [];

  const baseline = entries.slice(0, firstHuman).filter((e) => e.actor === "agent").at(-1);
  if (baseline === undefined) return [];

  const after = entries.filter((e) => e.actor === "human").at(-1)!;
  if (after.content === baseline.content) return [];

  return [{ itemId: after.itemId, before: baseline.content, after: after.content }];
}
