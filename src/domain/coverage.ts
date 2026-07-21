import type { AssembledThread } from "./models";

/** One appended entry in the collection run ledger. */
export interface CollectionRun {
  target: string;
  ranAt: string;
  requested: { since: string | null; until: string };
  covered: { from: string; to: string } | null;
  threadCount: number;
  tweetCount: number;
  truncated: boolean;
  gap: { from: string | null; to: string } | null;
}

/**
 * Derive covered range, tweet count, and any gap from the kept threads.
 * `covered` spans the min..max createdAt of every kept tweet (null if none).
 * `gap` is set only when `truncated`: from the requested floor to the oldest covered.
 */
export function computeCoverage(
  threads: AssembledThread[],
  requested: { since: string | null; until: string },
  truncated: boolean,
): { covered: { from: string; to: string } | null; tweetCount: number; gap: { from: string | null; to: string } | null } {
  const tweets = threads.flatMap((t) => t.tweets);
  if (tweets.length === 0) return { covered: null, tweetCount: 0, gap: null };

  let from = tweets[0].createdAt;
  let to = tweets[0].createdAt;
  for (const t of tweets) {
    if (t.createdAt < from) from = t.createdAt;
    if (t.createdAt > to) to = t.createdAt;
  }
  const gap = truncated ? { from: requested.since, to: from } : null;
  return { covered: { from, to }, tweetCount: tweets.length, gap };
}
