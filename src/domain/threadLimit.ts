import type { AssembledThread } from "./models";

/** A thread's newest moment = its last (chronological) tweet's createdAt. */
function newestAt(thread: AssembledThread): string {
  return thread.tweets[thread.tweets.length - 1]?.createdAt ?? "";
}

/**
 * Keep the newest `limit` threads (by latest tweet). Applied after assembly so
 * every kept thread is complete. `truncated` is true only when threads are dropped.
 */
export function applyThreadLimit(
  threads: AssembledThread[],
  limit: number | undefined,
): { kept: AssembledThread[]; truncated: boolean } {
  if (limit === undefined || threads.length <= limit) {
    return { kept: threads, truncated: false };
  }
  const sorted = [...threads].sort((x, y) => newestAt(y).localeCompare(newestAt(x)));
  return { kept: sorted.slice(0, limit), truncated: true };
}
