import type { CollectedThread } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";
import { renderArticle } from "../../domain/articleMarkdown";

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
      // A tweet with a fetched article body renders as markdown; everything else keeps its own
      // text. Handling it per tweet rather than per thread means a thread mixing the two still
      // reads correctly, and an article whose body fetch failed simply falls back to its link.
      const hasArticle = thread.tweets.some((t) => t.article?.blocks?.length);
      items.push({
        id,
        source: "x",
        text: thread.tweets
          .map((t) => (t.article?.blocks?.length ? renderArticle(t.article) : t.text))
          .join(THREAD_TWEET_SEPARATOR),
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
        kind: hasArticle ? "article" : "post",
      });
    }
    return items;
  }
}
