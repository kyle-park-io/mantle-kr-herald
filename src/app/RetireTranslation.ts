import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { RecordPublish } from "./RecordPublish";

/** What `RetireTranslation.run` was given: one row of `reconcileXPublished`'s `plan.posted`. */
export interface RetireInput {
  itemId: string;
  /** The live post's root tweet id — required, and what lands in the history row's `postId`. An
   *  earlier draft of this plan omitted it, caught because the history row could not have been
   *  built without one. */
  rootId: string;
  url: string;
  postedAt: string;
}

/**
 * Records that a translation already went out by hand — the write half of `plan.posted`
 * (`src/app/ReconcileXPublished.ts`). Reads as `RecordObservedDelivery`'s sibling: both accept one
 * already-decided observation and record it idempotently, both return a discriminated string
 * outcome rather than a boolean so a caller walking a whole plan can tell what happened without a
 * second read, and neither one decides anything — `reconcileXPublished`/`bestThreadFor` already
 * made the call before either class ever sees the row.
 *
 * Two writes, not one, and they are idempotent **independently** — see the ordering note below:
 *
 * 1. The `Translation` row: `status` → `"posted"`, `postedUrl`/`postedAt` stamped. Idempotent on
 *    `postedUrl` already being set — re-matching an already-retired translation would silently
 *    undo a human's 되돌리기 the moment reconcile ran again, which is exactly what
 *    `reconcileXPublished` already refuses to hand this class a second time (see its own doc
 *    comment on `postedUrl !== undefined`), but this class refuses it too rather than trusting the
 *    caller never to change.
 * 2. The `history` tab row (`PublishRecord`, via `publisher`), keyed `x:<itemId>` — never
 *    `kr:<rootId>`, which is `externalHistoryRecord`'s spelling for a post nobody has claimed. This
 *    one has an owner. Idempotent on `historyIds`/`historyPostIds`, the same two-way check
 *    `reconcileXPublished`'s own `external` pass uses and for the same reason: the tab's real
 *    identity for an X row is the postId in column D, and a live post already recorded under a
 *    *different* itemId (the manual `history:record` path, or a stale `send:channels` row) must
 *    not gain a second row that `impressions:record` would then double-count.
 *
 * **Status write first, history row second — load-bearing, not incidental.** A history row written
 * first would land in `historyPostIds` on the very next reconcile run, and `reconcileXPublished`
 * treats a `historyPostIds` hit as "already recorded" for the *external* pass, not as "already
 * retired" for this one — nothing re-drives this class for that item once the row exists on the
 * sheet side. So if the status write then failed (crash, DB blip) between the two writes, the
 * translation would sit forever in whatever status it already had, permanently unretireable, with
 * no error anywhere pointing at it. Writing status first means the opposite failure — history
 * write throws — leaves a translation correctly marked `posted` with the row visible in the plan
 * as `plan.posted` again next run (its `postId` not yet in `historyPostIds`), so the history write
 * simply retries. That failure is caught here and swallowed, not reported as a failure to retire:
 * the translation-row write is what a human's 검수 board and any later `SaveTranslation` need to
 * see, and it already succeeded.
 *
 * **Residual race, not fixed here:** both this class's write and `SaveTranslation.run`'s (see that
 * file's own comment) are a `loadAll` + find + full-row `upsert` — read, then write the whole row
 * back, no version check, no lock. A `SaveTranslation` save and a `RetireTranslation` retire
 * racing the same `itemId` can therefore clobber each other: whichever `upsert` lands last wins
 * outright, and it wins with whatever the *other* fields looked like at ITS OWN read time, not at
 * the other writer's commit time. Concretely — a human edits a translation's Korean text at
 * roughly the same moment reconcile retires it: if the save's read happened before the retire's
 * write landed, the save does not yet see `postedUrl`, and if the save's write then lands *after*
 * the retire's, it silently resurrects `status: "translated"`/`"approved"` with no `postedUrl` at
 * all — the retire is gone, and nothing said so. The reverse is also possible: a retire whose read
 * predates a save landing after it re-asserts the pre-edit text under `status: "posted"`. Neither
 * write is "wrong" in isolation; the race is in the gap between the read and the write neither
 * side can see across. Out of scope here by design (see task-4-brief.md) — flagged for whoever
 * builds the dashboard's save/revert buttons next (Task 5), since concurrent human+reconcile writes
 * are exactly the shape those buttons introduce.
 */
export class RetireTranslation {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly publisher: RecordPublish,
    private readonly historyIds: Set<string>,
    private readonly historyPostIds: Set<string>,
  ) {}

  async run(input: RetireInput): Promise<"retired" | "already-retired"> {
    const { itemId, rootId, url, postedAt } = input;

    const all = await this.translationStore.loadAll();
    const existing = all.find((t) => t.itemId === itemId);
    if (existing === undefined) {
      // reconcileXPublished built plan.posted from the same translations list this itemId came
      // from, so this should be unreachable outside a caller passing a stale plan against a store
      // whose row vanished in between — worth failing loudly on rather than silently writing a
      // fresh row with none of the translation's own history.
      throw new Error(`RetireTranslation: no translation row for ${itemId} — cannot retire what does not exist`);
    }
    if (existing.postedUrl !== undefined) return "already-retired";

    // Spread `existing`, not a fresh object: only status/postedUrl/postedAt are this class's to
    // set. Every other field (sourceText, koreanText, approvedAt, isReply, refUrl, ...) is
    // preserved from the row this class just read — the same "only touch the columns you own"
    // discipline SaveTranslation's own upsert keeps for postedUrl/postedAt, mirrored here in the
    // other direction.
    const updated: Translation = { ...existing, status: "posted", postedUrl: url, postedAt };
    await this.translationStore.upsert(updated);

    const alreadyInHistory = this.historyIds.has(itemId) || this.historyPostIds.has(rootId);
    if (!alreadyInHistory) {
      try {
        await this.publisher.record({
          itemId,
          type: "x",
          channel: "x",
          outletId: "x-post",
          postId: rootId,
          url,
          status: "posted",
          publishedAt: postedAt,
        });
      } catch (err) {
        // Swallowed, not re-thrown: the translation is already correctly retired above, and the
        // next run's history read (historyPostIds still missing this rootId) will retry this row.
        // See this class's own doc comment for why the write order makes that retry safe.
        console.error(`[retire] history write failed for ${itemId} (post ${rootId}): ${(err as Error).message}`);
      }
    }

    return "retired";
  }
}
