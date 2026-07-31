import type { CollectedThread, MediaItem, SourceTweet } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";
import { renderArticle } from "../../domain/articleMarkdown";

/** Separates individual tweets within a thread so their boundaries survive into the
 *  worksheet and the review/approved docs (a plain blank line is indistinguishable
 *  from a line break inside a single tweet). */
const THREAD_TWEET_SEPARATOR = "\n\n---\n\n";

/** A reply Mantle made to someone else's comment, bundled into a thread by conversationId — its text
 *  leads with an @mention. A self-thread continuation is also `isReply` but does NOT lead with `@`, so
 *  it stays unmarked. Applied to non-root tweets only: a standalone reply item (root isReply) is already
 *  flagged by the item-level header marker (ContentItem.isReply). */
export const COMMENTER_REPLY_MARKER = "(댓글 · 지워도 됨)";

function isCommenterReply(t: SourceTweet): boolean {
  return t.isReply && t.text.trimStart().startsWith("@");
}

/** Surface a post's media as canonical markers, each on its own line, so it is visible through the
 *  pipeline and delivered from the reviewed text (see domain/media/sourceMedia). Photos use the
 *  empty-alt image form; a video/gif uses a paren-free [영상] marker (mp4 upload is a follow-up). */
function mediaMarkers(media: MediaItem[] | undefined): string {
  if (!media || media.length === 0) return "";
  const lines = media.map((m) => (m.type === "photo" ? `![](${m.url})` : "[영상]"));
  return `\n\n${lines.join("\n")}`;
}

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
  return { text: t.text + mediaMarkers(t.media), isArticle: false };
}

/**
 * Pure: flattens collected X threads to `ContentItem[]`, filtering out deleted threads and ids
 * already in `translatedIds`. Only `rootId`/`tweets`/`status` are read, so a caller that never
 * tracked `firstSeenAt`/`deletedAt` (e.g. a row straight out of the database) can pass those in
 * without fabricating the rest of `CollectedThread`. Shared by `XContentSource` (reads
 * `items.json`) and `PgContentSource` (reads the `x_threads` table) so both sources flatten
 * threads — including media markers and article rendering — exactly the same way.
 */
export function flattenXThreads(
  threads: Pick<CollectedThread, "rootId" | "tweets" | "status">[],
  translatedIds: Set<string>,
): ContentItem[] {
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
      .map((t, i) => {
        const rendered = renderTweetText(t);
        if (rendered.isArticle) hasArticle = true;
        return i > 0 && isCommenterReply(t) ? `${COMMENTER_REPLY_MARKER} ${rendered.text}` : rendered.text;
      })
      .join(THREAD_TWEET_SEPARATOR);
    items.push({
      id,
      source: "x",
      text,
      createdAt: first?.createdAt ?? "",
      refUrl: first?.url,
      isReply: first?.isReply,
      kind: hasArticle ? "article" : "post",
    });
  }
  return items;
}

export class XContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const threads = await readJsonFile<CollectedThread[]>(this.itemsPath, []);
    return flattenXThreads(threads, translatedIds);
  }
}
