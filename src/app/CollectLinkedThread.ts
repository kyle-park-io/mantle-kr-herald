import type { CollectedThread, SourceTweet } from "../domain/models";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { SourceGateway } from "../ports/SourceGateway";
import type { TranslationStore } from "../ports/TranslationStore";
import { systemClock, type Clock } from "../ports/Clock";
import { parsePostUrl } from "../domain/publish/xReconcile";
import { assembleThreads } from "../domain/threadAssembler";
import { isCommenterReply } from "../adapters/content/XContentSource";

export const INTAKE_BAD_URL = "x.com/<계정>/status/<번호> 형태의 주소가 필요합니다";
export const INTAKE_NOT_FOUND = "그 글을 가져올 수 없습니다 — 삭제됐거나 비공개일 수 있습니다";
export const INTAKE_REPLY = "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다";

/**
 * What the caller learns about a link it just submitted. `already-*` are not refusals — the thread
 * was re-collected either way (see `run`) — they exist so the screen can say where the item already
 * is instead of implying the click did nothing.
 */
export type IntakeOutcome = "collected" | "already-pending" | "already-translated";

export interface IntakeResult {
  itemId: string;
  tweets: number;
  outcome: IntakeOutcome;
}

/**
 * One x.com link → one row in the collection repository, on the same terms a timeline sweep writes.
 *
 * The one thing this deliberately does NOT do is touch the collect watermark. The watermark means
 * "how far down the timeline `pnpm collect` has read"; a link intake reads no timeline, so advancing
 * it would make the next scheduled sweep skip everything posted in between. `CollectAuthoredContent`
 * makes the same call for its own adhoc runs (`--since`/`--limit`). Not touching it — and not
 * touching the run ledger either — is also what keeps this path off the filesystem entirely, which
 * is what lets it run inside the Vercel function where the FS is read-only.
 *
 * No author filter, on purpose: the point of this entry point is a post the pipeline's own account
 * did not write. `flattenXThreads` has no author condition either, so the item flows on unchanged.
 */
export class CollectLinkedThread {
  constructor(
    private readonly gateway: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly translationStore: TranslationStore,
    private readonly now: Clock = systemClock,
  ) {}

  async run(url: string): Promise<IntakeResult> {
    const parsed = parsePostUrl(url.trim());
    if (!parsed) throw new Error(INTAKE_BAD_URL);
    // `parsePostUrl` names this `rootId` because its own caller (`x:reconcile`) only ever reads urls
    // this codebase wrote, which always point at a root. A person pastes whatever tweet they were
    // looking at — x.com offers "copy link" on every one — so here it is just the linked tweet's id.
    const linkedTweetId = parsed.rootId;

    const tweets = await this.gateway.fetchThread(linkedTweetId);
    if (tweets.length === 0) throw new Error(INTAKE_NOT_FOUND);

    await this.fillArticleBodies(tweets);

    // Matched by *containment*, not by root id: a link to the second tweet of a thread carries that
    // tweet's id, and `assembleThreads` keys threads by conversationId, so comparing the two told the
    // operator the thread was "deleted or private" when it was neither — and everything below then
    // works from `thread.rootId`, so the row and the item id are the ones a timeline sweep of the
    // same thread would produce rather than a second row for one conversation.
    const thread = assembleThreads(tweets).find((t) => t.tweets.some((x) => x.id === linkedTweetId));
    // The gateway answered, but about a different conversation. Storing it would file the wrong post
    // under the id the operator asked for, which no later stage could detect.
    if (!thread) throw new Error(INTAKE_NOT_FOUND);

    // Refused here rather than left to be dropped downstream. `flattenXThreads` skips a thread whose
    // first tweet is a commenter reply *silently* — collected successfully, then absent from 1차 검수
    // two hours later with no error anywhere for anyone to find.
    if (isCommenterReply(thread.tweets[0])) throw new Error(INTAKE_REPLY);

    const itemId = `x:${thread.rootId}`;
    const [existing, translatedIds] = await Promise.all([
      this.repo.loadAll(),
      this.translationStore.listTranslatedIds(),
    ]);
    const outcome: IntakeOutcome = translatedIds.has(itemId)
      ? "already-translated"
      : existing.some((t) => t.rootId === thread.rootId)
        ? "already-pending"
        : "collected";

    // Upserted even when it was already here: the thread may have grown a tail since, and `upsert`
    // preserves `firstSeenAt` while `mergeTweet` protects a stored article body from a re-fetch that
    // came back without one.
    const collected: CollectedThread = {
      rootId: thread.rootId,
      tweets: thread.tweets,
      status: "active",
      firstSeenAt: this.now(),
    };
    await this.repo.upsert([collected]);

    return { itemId, tweets: thread.tweets.length, outcome };
  }

  /** An article's body is a second call — the thread response marks the tweet as an article but
   *  never carries its blocks. Mirrors `CollectAuthoredContent.fillArticleBodies`. */
  private async fillArticleBodies(tweets: SourceTweet[]): Promise<void> {
    for (const t of tweets) {
      if (!t.article || (t.article.blocks?.length ?? 0) > 0) continue;
      t.article = { ...t.article, blocks: await this.gateway.fetchArticle(t.id) };
    }
  }
}
