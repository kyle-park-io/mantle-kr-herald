import type { CollectedThread } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

/** Separates individual tweets within a thread so their boundaries survive into the
 *  worksheet and the review/approved docs (a plain blank line is indistinguishable
 *  from a line break inside a single tweet). */
const THREAD_TWEET_SEPARATOR = "\n\n---\n\n";

export class XContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const threads = await readJsonFile<CollectedThread[]>(this.itemsPath, []);
    const items: ContentItem[] = [];
    for (const thread of threads) {
      if (thread.status !== "active") continue;
      const id = `x:${thread.rootId}`;
      if (translatedIds.has(id)) continue;
      const first = thread.tweets[0];
      items.push({
        id,
        source: "x",
        text: thread.tweets.map((t) => t.text).join(THREAD_TWEET_SEPARATOR),
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
      });
    }
    return items;
  }
}
