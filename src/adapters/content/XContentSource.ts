import type { CollectedThread, MediaItem, SourceTweet } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";
import { renderArticle } from "../../domain/articleMarkdown";
import { THREAD_TWEET_SEPARATOR } from "../../domain/formatting/canonical";



/**
 * A reply Mantle made to someone else, bundled into a thread by conversationId — it is `isReply`
 * AND its text leads with an @mention. Both halves are required, and each rules out a real case the
 * other would destroy: a self-thread continuation is `isReply` but does not lead with `@`
 * ("Come Saturday, trade here"), while a genuine post can open with a mention without being a reply
 * ("@Fluxion_network is now live on Mantle.").
 *
 * These are dropped from the pipeline entirely — the thread never becomes a `ContentItem`, and a
 * nested one never reaches the 원문. They used to be kept: a reply-rooted thread arrived in 1차 검수
 * as its own row, and a nested one was prefixed "(댓글 · 지워도 됨)", an instruction to the
 * translator to delete it by hand on every worksheet, forever.
 *
 * Measured against production on 2026-08-07: **92 of 221 collected threads (42%) were reply-only**,
 * and 140 nested reply blocks sat across 46 threads. None of it is Korean announcement copy — it is
 * "@elfa_ai 🥳🥳", "@Agnidex 💚", "@ethereum Onwards." Filtering at the source, rather than asking a
 * human to skip them, is the same call `collect:reference` already makes for @0xMantleKR's own
 * posts: content that can never be the pipeline's input does not belong in its queue.
 *
 * The cost, stated plainly: this is total. A reply excluded here cannot be recovered by
 * `translate:prepare --ids`, because it never becomes an item for the selector to find. Reaching one
 * would take a code change or a hand-written `translate:save`.
 *
 * Exported because `pnpm status` now reports the toll (`xThreadIntake` below, printed on the
 * Collected line). It is the predicate itself that travels, never a second copy of the rule: a copy
 * can drift from the one that actually filters, and the funnel would then print a number no code
 * path agrees with — which is worse than the bare total it replaced, because it looks checked.
 */
export function isCommenterReply(t: SourceTweet): boolean {
  return t.isReply && t.text.trimStart().startsWith("@");
}

/** What X collection handed the pipeline, and what the reply filter took out before anything was
 *  rendered — the two numbers in front of `pnpm status`'s Collected total. */
export interface XThreadIntake {
  /** Threads the pipeline considered. `status === "active"` only: a deleted thread was not dropped
   *  by any rule, it never enters the funnel at all, so counting it would put a number on screen
   *  that nothing downstream can ever produce. */
  threads: number;
  /** Of those, the ones dropped whole because their FIRST tweet is a commenter reply. A thread with
   *  a *nested* commenter reply is not counted here: it still becomes an item, minus that block. */
  repliesDropped: number;
}

/**
 * The reply filter's toll, counted rather than described.
 *
 * `pnpm status` printed a bare `Collected (X + Lark) 134` while 92 threads — 41% of everything ever
 * collected — had been dropped here before becoming items, and answering "is 134 even right?" took
 * a database query. A number that costs a query to verify belongs on screen.
 *
 * Counted beside the filter, over the same predicate and the same two guards `flattenXThreads`
 * applies in the same order, so `threads - repliesDropped` is exactly `flattenXThreads(rows, new
 * Set()).length` — the empty set being what `pnpm status` passes, since it asks for everything
 * collected rather than for what is still untranslated. `tests/adapters/content/xContentSource.test.ts`
 * asserts that identity directly; it is the only thing keeping the printed funnel honest.
 */
export function xThreadIntake(threads: Pick<CollectedThread, "tweets" | "status">[]): XThreadIntake {
  let considered = 0;
  let repliesDropped = 0;
  for (const thread of threads) {
    if (thread.status !== "active") continue;
    considered += 1;
    const first = thread.tweets[0];
    if (first && isCommenterReply(first)) repliesDropped += 1;
  }
  return { threads: considered, repliesDropped };
}

/** Surface a post's media as canonical markers, each on its own line, so it is visible through the
 *  pipeline and delivered from the reviewed text (see domain/media/sourceMedia). Photos use the
 *  labelled `[사진](url)` form; a video/gif uses `[영상] <mp4 url>` — paren-free, because
 *  `[영상](url)` is a markdown link that `linksToPlain`'s MD_LINK would rewrite. The url is dropped
 *  when collection captured none (a pre-`videoUrl` row, or a payload with no mp4 variant), leaving
 *  the bare `[영상]` that every reader still accepts. The thumbnail is never emitted: it is a still
 *  image, and a reviewer seeing it in the video slot would think the clip was carried. */
function mediaMarkers(media: MediaItem[] | undefined): string {
  if (!media || media.length === 0) return "";
  const lines = media.map((m) =>
    m.type === "photo" ? `[사진](${m.url})` : m.videoUrl ? `[영상] ${m.videoUrl}` : "[영상]",
  );
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
    // A thread that opens with a reply to someone else is that conversation, not a Mantle post —
    // skipped before anything is rendered, so it never becomes a review row. See isCommenterReply.
    if (first && isCommenterReply(first)) continue;
    // Nested replies go the same way, and are removed here rather than marked, so the 원문 holds
    // only what a translator is meant to translate.
    const kept = thread.tweets.filter((t, i) => i === 0 || !isCommenterReply(t));
    // Handling this per tweet rather than per thread means a thread mixing an article with
    // ordinary replies still reads correctly.
    let hasArticle = false;
    const text = kept
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
      isReply: first?.isReply,
      kind: hasArticle ? "article" : "post",
      // Read by nothing on screen — it is what lets `meetsTranslateFloor` apply the translate floor
      // to the swept account only, for the tick, the 링크 수집 waiting list and the Collected count
      // alike (see `ContentItem.author`). Taken from the root tweet, the same tweet `createdAt`
      // above comes from, so the two facts the floor rule compares describe one post.
      author: first?.authorUserName,
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
