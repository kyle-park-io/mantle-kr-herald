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
 * What `run` actually did, reported as two **independent** outcomes rather than one collapsed
 * boolean — see this class's own doc comment for why collapsing them was Task 4 review's Finding 1.
 */
export interface RetireResult {
  /** Whether the `Translation` row's `status`/`postedUrl`/`postedAt` were written this call
   *  (`"retired"`), or were already there from an earlier one (`"already-retired"`, no write). */
  status: "retired" | "already-retired";
  /** Whether the `history` tab row was written this call (`"written"`), was already there
   *  (`"skipped"`, via `historyPostIds` — no write attempted), or the write attempt threw and was
   *  swallowed (`"failed"` — the caller decides whether that should fail the run; see
   *  `x-reconcile.ts`). */
  history: "written" | "skipped" | "failed";
}

/**
 * Records that a translation already went out by hand — the write half of `plan.posted`
 * (`src/app/ReconcileXPublished.ts`). Reads as `RecordObservedDelivery`'s sibling: both accept one
 * already-decided observation and record it idempotently, both return a discriminated outcome
 * rather than a boolean so a caller walking a whole plan can tell what happened without a second
 * read, and neither one decides anything — `reconcileXPublished`/`bestThreadFor` already made the
 * call before either class ever sees the row.
 *
 * Two writes, not one, and each is idempotent **on its own terms** — see `RetireResult`:
 *
 * 1. The `Translation` row: `status` → `"posted"`, `postedUrl`/`postedAt` stamped. Idempotent on
 *    `postedUrl` already being set: never overwritten once set, so a human's 되돌리기 (a manual
 *    correction to `postedUrl`) always sticks, and a translation this class already retired is
 *    never re-applied with a possibly-different match from a later run.
 * 2. The `history` tab row (`PublishRecord`, via `publisher`), keyed `x:<itemId>` — never
 *    `kr:<rootId>`, which is `externalHistoryRecord`'s spelling for a post nobody has claimed. This
 *    one has an owner. Idempotent on `historyPostIds` alone (see Finding 3 below) — the tab's real
 *    identity for an X row is the postId in column D, and a live post already recorded under a
 *    *different* itemId (the manual `history:record` path, or a stale `send:channels` row) must
 *    not gain a second row that `impressions:record` would then double-count.
 *
 * **The two halves are attempted independently — no early return short-circuits the history
 * write.** This is Task 4 review's Finding 1, fixed here: the original version returned
 * `"already-retired"` the moment `existing.postedUrl` was already set, *before* ever reaching the
 * history write below. Paired with `reconcileXPublished`'s old unconditional
 * `postedUrl !== undefined → skip`, that meant a translation whose status write landed but whose
 * history write threw could never be retried — it would never re-enter `plan.posted`, and this
 * class would never see it again. The plan's own comment claimed the opposite ("a failing history
 * write leaves the translation retired and the next run retrying"), which was simply false.
 * `reconcileXPublished` now re-admits a `postedUrl`-set translation to `plan.posted` whenever its
 * matched thread's rootId is still missing from `historyPostIds` (see that function's own doc
 * comment), and this class now computes `status` and `history` as two separate local variables,
 * neither one gating the other: `status` is `"already-retired"` (no upsert) whenever `postedUrl` is
 * already set, and *regardless of that*, `history` is always attempted unless `historyPostIds`
 * already has this `rootId`.
 *
 * **Status write first, history row second, when both happen — load-bearing, not incidental.** A
 * history row written before the status row would land in `historyPostIds` on the very next
 * reconcile run while the translation itself still lacked `postedUrl` — a state
 * `reconcileXPublished`'s conjunctive skip (`postedUrl` set **and** `historyPostIds` has the
 * rootId) can never produce on its own, so nothing would ever re-drive the status write for that
 * item if it had failed. Status first means the opposite failure — history write throws — leaves a
 * translation correctly marked `posted`, with `historyPostIds` still missing its rootId, so
 * `reconcileXPublished`'s conjunctive skip re-admits it to `plan.posted` next run and this class
 * gets another attempt at just the history half. A history failure is caught here and logged, never
 * re-thrown — the caller (`x-reconcile.ts`) is the one that decides whether `history: "failed"`
 * should fail the whole run's exit code (Finding 2); this class's job is only to report what
 * happened truthfully, on both halves.
 *
 * **Finding 3 — only `historyPostIds` guards the history write, never `historyIds`.** An earlier
 * draft of this class also skipped when `historyIds.has(itemId)` (the `history` tab's column A,
 * read across every channel). That was wrong on two counts: it is redundant
 * (`RecordPublish.record` already matches on `(itemId, type, channel, outletId)` and updates rather
 * than duplicates, so nothing needed a pre-check), and it could actively suppress a legitimate row
 * — `SendChannels.ts` writes a Telegram delivery under the same bare `x:<itemId>` in column A, so an
 * item whose Telegram send succeeded but whose X post was made by hand would have its X history row
 * skipped forever once Finding 1 made "skipped" durable. `historyPostIds` (column D, the postId) is
 * the guard that actually protects against two rows for one post, and is the only one this class
 * still consults.
 *
 * **Residual race, not fixed here:** both this class's status write and `SaveTranslation.run`'s (see
 * that file's own comment) are a `loadAll` + find + full-row `upsert` — read, then write the whole
 * row back, no version check, no lock. A `SaveTranslation` save and a `RetireTranslation` retire
 * racing the same `itemId` can therefore clobber each other: whichever `upsert` lands last wins
 * outright, and it wins with whatever the *other* fields looked like at ITS OWN read time, not at
 * the other writer's commit time. Concretely — a human edits a translation's Korean text at roughly
 * the same moment reconcile retires it: if the save's read happened before the retire's write
 * landed, the save does not yet see `postedUrl`, and if the save's write then lands *after* the
 * retire's, it silently resurrects `status: "translated"`/`"approved"` with no `postedUrl` at all —
 * the retire is gone, and nothing said so. The reverse is also possible: a retire whose read
 * predates a save landing after it re-asserts the pre-edit text under `status: "posted"`. Neither
 * write is "wrong" in isolation; the race is in the gap between the read and the write neither side
 * can see across. Out of scope here by design (see task-4-brief.md) — flagged for whoever builds the
 * dashboard's save/revert buttons next (Task 5), since concurrent human+reconcile writes are exactly
 * the shape those buttons introduce.
 */
export class RetireTranslation {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly publisher: RecordPublish,
    private readonly historyPostIds: Set<string>,
  ) {}

  async run(input: RetireInput): Promise<RetireResult> {
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

    let status: RetireResult["status"];
    if (existing.postedUrl !== undefined) {
      status = "already-retired";
    } else {
      // Spread `existing`, not a fresh object: only status/postedUrl/postedAt are this class's to
      // set. Every other field (sourceText, koreanText, approvedAt, isReply, refUrl, ...) is
      // preserved from the row this class just read — the same "only touch the columns you own"
      // discipline SaveTranslation's own upsert keeps for postedUrl/postedAt, mirrored here in the
      // other direction.
      const updated: Translation = { ...existing, status: "posted", postedUrl: url, postedAt };
      await this.translationStore.upsert(updated);
      status = "retired";
    }

    // Attempted regardless of `status` above — see this class's own doc comment (Finding 1) for
    // why an early return here was the bug: it made a stuck history write permanently unretryable.
    let history: RetireResult["history"];
    if (this.historyPostIds.has(rootId)) {
      history = "skipped";
    } else {
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
        history = "written";
      } catch (err) {
        // Swallowed, not re-thrown: the caller decides whether this should fail the run (see
        // x-reconcile.ts, Finding 2). The next run's history read (historyPostIds still missing
        // this rootId) will retry this write — see the ordering note above for why that's safe.
        console.error(`[retire] history write failed for ${itemId} (post ${rootId}): ${(err as Error).message}`);
        history = "failed";
      }
    }

    return { status, history };
  }
}
