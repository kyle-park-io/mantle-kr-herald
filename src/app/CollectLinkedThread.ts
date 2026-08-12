import type { CollectedThread, SourceTweet } from "../domain/models";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { SourceGateway } from "../ports/SourceGateway";
import type { TranslationStore } from "../ports/TranslationStore";
import { systemClock, type Clock } from "../ports/Clock";
import type { TranslateFloorReport } from "../status/translateFloor";
import { parsePostUrl } from "../domain/publish/xReconcile";
import { assembleThreads } from "../domain/threadAssembler";
import { meetsTranslateFloor } from "../domain/translation/translateFloor";
import { isCommenterReply } from "../adapters/content/XContentSource";

export const INTAKE_BAD_URL = "x.com/<계정>/status/<번호> 형태의 주소가 필요합니다";
export const INTAKE_NOT_FOUND = "그 글을 가져올 수 없습니다 — 삭제됐거나 비공개일 수 있습니다";
export const INTAKE_REPLY = "이 글은 다른 대화에 단 답글이라 파이프라인에 올릴 수 없습니다";

/**
 * The other half of the reply refusal, and its own sentence because it is its own situation.
 *
 * `INTAKE_REPLY` above is the thread that *opens* with a commenter reply: `flattenXThreads` throws
 * the whole thread away, so there is no item at all. This one is a link aimed at a commenter reply
 * *inside* a thread — the thread itself may be entirely collectable, and `flattenXThreads` keeps it
 * while filtering that tweet, along with every other nested commenter reply, out of the item text.
 * Accepting the link would answer with an outcome — "수집됐습니다", or one of the `already-*` — about
 * a thread assembled without the tweet the operator was pointing at.
 *
 * Stretched, `INTAKE_REPLY` would say "다른 대화에 단 답글" about a reply that is in *this*
 * conversation, so this says what becomes of the linked post and what to paste instead.
 */
export const INTAKE_LINKED_REPLY =
  "이 주소가 가리키는 글은 스레드에 달린 답글이라 번역 대상에서 빠집니다 — 스레드 본문 글의 주소를 넣어 주세요";

/**
 * The one refusal that carries a value, so it is a function where its three neighbours are
 * constants. The floor is what the operator has to know, and `HERALD_TRANSLATE_SINCE` is named
 * beside it because that is the dial — a refusal that does not say what would change the answer
 * leaves the reader guessing. The instant goes in as the scheduler reported it (normalised by
 * `parseTranslateSince` on its side, the same string `pnpm status` prints) rather than reformatted
 * here: this is the value to compare the unit file against, not a date to read aloud.
 */
export function intakeBelowFloorMessage(floor: string): string {
  return `이 글은 번역 기준 시각(${floor})보다 오래돼 자동 번역되지 않습니다 — 정말 필요하면 HERALD_TRANSLATE_SINCE를 내려야 합니다`;
}

/**
 * How this use case learns the translate floor. `createDeps`'s `readFloorReport` is the real one:
 * `WatchTick` writes down the floor it actually ran with at the start of every tick, so a Vercel
 * function with no systemd to ask still gets the scheduler's own answer out of Postgres.
 *
 * Injected rather than read here, for the reason `src/status/translateFloor.ts` exists at all — the
 * invoking process's own `HERALD_TRANSLATE_SINCE` says nothing about what the scheduler runs with,
 * and in the hosted deployment it is simply never set.
 */
export type TranslateFloorReader = () => Promise<TranslateFloorReport | undefined>;

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
 * The author is *read* once — handed to `meetsTranslateFloor` by `refuseIfBelowFloor` — but only as
 * an input to who the translate floor applies to, never to decide whose posts are welcome.
 */
export class CollectLinkedThread {
  constructor(
    private readonly gateway: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly translationStore: TranslationStore,
    private readonly now: Clock = systemClock,
    /** Defaults to "no floor known", which collects everything — see the gate in `run`. A caller
     *  that can reach the scheduler's report (`createDeps`) passes it; a test that is not about the
     *  floor leaves it out. */
    private readonly readFloor: TranslateFloorReader = async () => undefined,
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

    // The same silent drop, one tweet down. Containment matching above means a link to a stranger's
    // comment resolves to the thread that comment hangs off, and `flattenXThreads` filters nested
    // commenter replies out of the item text — so the linked tweet is one the item would not
    // contain, while the screen said the link was collected. Checked after the root, so a
    // link to a root that is itself a commenter reply still gets `INTAKE_REPLY`'s wording.
    // `find` cannot miss here — `thread` was chosen for containing this id — and is written as a
    // guard rather than an assertion so the type says so too.
    const linked = thread.tweets.find((t) => t.id === linkedTweetId);
    if (linked && isCommenterReply(linked)) throw new Error(INTAKE_LINKED_REPLY);

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

    // Reads only, above — nothing has been written yet, which is what lets the floor refuse here.
    // It is skipped for an already-translated item on purpose: the refusal is a statement about what
    // a tick will do, and "이 글은 …오래돼 자동 번역되지 않습니다" about a post already sitting in
    // 1차 검수 is simply false. `already-pending` is not skipped — a below-floor item waiting in
    // that queue is precisely one no tick will take, and saying so is more use than repeating
    // "번역 틱이 돌면 처리됩니다".
    if (outcome !== "already-translated") await this.refuseIfBelowFloor(thread.tweets[0]);

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

  /**
   * The second silent-failure door, beside `isCommenterReply`'s.
   *
   * **The rule is not written here.** `meetsTranslateFloor`
   * (`src/domain/translation/translateFloor.ts`) answers "does the floor let a tick select this
   * item?", and `PrepareTranslations.applySelector`, `createDeps.loadIntakePending` and
   * `collectedScope` all ask that same function. This door asks it too, so what it refuses is by
   * construction what no tick would take. A door that re-stated the rule would be a fourth copy, and
   * the fourth copy this replaced did disagree with the other three: it asked `isSweptAccount`,
   * which answers `false` for the `""` that `normalizeTweet` stores when live data omits the author,
   * while the rule *keeps* the floor for an author it cannot read. A pre-floor link whose root
   * arrived authorless was therefore collected, answered `collected`, then filtered out of the
   * waiting list and never selected — the failure this whole area exists to remove, through the one
   * input it was told to be careful about.
   *
   * What that function's answer means for the three cases this door sees: a post from another
   * account proceeds whatever its date, because nothing files another account's thread in
   * `x_threads` on its own (`src/domain/sweptAccount.ts`). A pre-floor post by the swept account
   * does not, because nothing distinguishes it from the swept backlog the floor exists to hold back.
   * A pre-floor post whose author cannot be read goes the same way as the swept account's, which is
   * the conservative direction and the one the tick takes. Either of those, left to be collected,
   * would be stored and then be nowhere: no tick selects it, and `loadIntakePending` applies this
   * same rule, so it does not even appear in the 링크 수집 waiting list to be wondered about.
   *
   * So it is refused before `repo.upsert`, with the date in the message — the refusal names the one
   * setting that would change the answer instead of leaving the operator to guess.
   *
   * Both facts come from the ROOT tweet, which is the tweet `flattenXThreads` builds the item's
   * `createdAt` and `author` from. Reading the handle out of the pasted url instead would judge
   * `https://x.com/i/status/<id>` — the form `itemUrl()` puts on every 1차 검수 row — as an account
   * named `i`, and let exactly the case this closes back through.
   *
   * No floor reported, or a report saying the tick ran with none: nothing is below anything, so
   * collect. A default floor invented here would refuse real posts on a guess. That is also what
   * `meetsTranslateFloor` answers for an `undefined` floor; the early return is here only so the
   * refusal below has a `string` to quote, since the message carries the date. It costs one indexed
   * single-row read per submission that the old gate skipped for another account's link —
   * `createDeps.readFloorReport` is the same reader the status card calls per request, and it
   * degrades to `undefined` rather than throwing.
   */
  private async refuseIfBelowFloor(root: SourceTweet): Promise<void> {
    const floor = (await this.readFloor())?.floor;
    if (floor === undefined) return;
    if (meetsTranslateFloor({ createdAt: root.createdAt, author: root.authorUserName }, floor)) return;
    throw new Error(intakeBelowFloorMessage(floor));
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
