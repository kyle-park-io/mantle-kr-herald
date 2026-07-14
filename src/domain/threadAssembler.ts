import type { AssembledThread, SourceTweet } from "./models";

/**
 * Group tweets into threads by conversationId (root tweet id) and sort each
 * thread chronologically. Pure — no I/O. Dedups by tweet id (last wins).
 */
export function assembleThreads(tweets: SourceTweet[]): AssembledThread[] {
  const byId = new Map<string, SourceTweet>();
  for (const t of tweets) byId.set(t.id, t);

  const groups = new Map<string, SourceTweet[]>();
  for (const t of byId.values()) {
    const key = t.conversationId || t.id;
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }

  const threads: AssembledThread[] = [];
  for (const [rootId, group] of groups) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    threads.push({ rootId, tweets: group });
  }

  threads.sort(
    (a, b) =>
      a.tweets[0].createdAt.localeCompare(b.tweets[0].createdAt) ||
      a.rootId.localeCompare(b.rootId),
  );
  return threads;
}
