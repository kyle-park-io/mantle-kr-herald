import type { CollectedThread, SourceTweet } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";
import { renderArticle } from "../../domain/articleMarkdown";

/** Separates individual tweets within a thread so their boundaries survive into the
 *  worksheet and the review/approved docs (a plain blank line is indistinguishable
 *  from a line break inside a single tweet). */
const THREAD_TWEET_SEPARATOR = "\n\n---\n\n";

/**
 * Render one tweet's text for the worksheet. A tweet with a fetched article body renders as
 * markdown; everything else keeps its own text. Rendering happens exactly once here and both
 * `text` and `isArticle` are derived from that single result, so an article whose blocks all
 * render to nothing (no title, and every block empty/dropped) falls back to the tweet's own text
 * — its t.co link — instead of putting an empty 원문 in the worksheet under an "article" label.
 */
function renderTweetText(t: SourceTweet): { text: string; isArticle: boolean } {
  if (t.article?.blocks?.length) {
    const rendered = renderArticle(t.article);
    if (rendered !== "") return { text: rendered, isArticle: true };
  }
  return { text: t.text, isArticle: false };
}

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
      // Handling this per tweet rather than per thread means a thread mixing an article with
      // ordinary replies still reads correctly.
      let hasArticle = false;
      const text = thread.tweets
        .map((t) => {
          const rendered = renderTweetText(t);
          if (rendered.isArticle) hasArticle = true;
          return rendered.text;
        })
        .join(THREAD_TWEET_SEPARATOR);
      items.push({
        id,
        source: "x",
        text,
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
        kind: hasArticle ? "article" : "post",
      });
    }
    return items;
  }
}
