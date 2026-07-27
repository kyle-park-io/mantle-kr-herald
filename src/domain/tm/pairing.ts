import type { ContentItem } from "../translation/contentItem";
import { extractAnchors, sharedAnchors } from "./anchors";

export interface PairOptions {
  /** KO must be published no more than this many days AFTER the EN post. */
  windowDays: number;
  /** Reject candidates sharing fewer than this many anchors. */
  minAnchors: number;
}

export interface ProposedPair {
  enId: string;
  koId: string;
  score: number;
  shared: string[];
  source: string; // EN text
  target: string; // KO text
}

const DAY_MS = 86_400_000;

export function proposePairs(
  enItems: ContentItem[],
  koItems: ContentItem[],
  opts: PairOptions,
): ProposedPair[] {
  const en = enItems.map((item) => ({ item, anchors: extractAnchors(item.text), t: Date.parse(item.createdAt) }));
  const pairs: ProposedPair[] = [];

  for (const ko of koItems) {
    const koT = Date.parse(ko.createdAt);
    if (Number.isNaN(koT)) continue;
    const koAnchors = extractAnchors(ko.text);

    let best: { item: ContentItem; shared: string[]; gap: number } | undefined;
    for (const cand of en) {
      if (Number.isNaN(cand.t)) continue;
      const gap = koT - cand.t;
      if (gap < 0 || gap > opts.windowDays * DAY_MS) continue;
      const shared = sharedAnchors(cand.anchors, koAnchors);
      if (shared.length < opts.minAnchors) continue;
      if (
        best === undefined ||
        shared.length > best.shared.length ||
        (shared.length === best.shared.length && gap < best.gap)
      ) {
        best = { item: cand.item, shared, gap };
      }
    }

    if (best) {
      pairs.push({
        enId: best.item.id,
        koId: ko.id,
        score: best.shared.length,
        shared: best.shared,
        source: best.item.text,
        target: ko.text,
      });
    }
  }
  return pairs;
}
