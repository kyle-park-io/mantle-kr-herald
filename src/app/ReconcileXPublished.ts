import {
  bestThreadFor,
  classify,
  externalHistoryRecord,
  findRootTweet,
  observedDelivery,
  postUrl,
  settledTranslationDisposition,
  TRANSLATION_MATCH_AT,
} from "../domain/publish/xReconcile";
import type { MatchCandidate } from "../domain/kol/attribution";
import type { AssembledThread } from "../domain/models";
import type { ChannelRendering } from "../domain/formatting/models";
import type { DeliveryEntry } from "../domain/delivery/models";
import { deliveryKey } from "../domain/delivery/models";
import type { PublishRecord } from "../domain/sheet/models";
import type { Translation } from "../domain/translation/models";

/**
 * Whether a rendering is one this reconcile may compare a live thread against, and therefore one it
 * may take a `type` from. Only `status: "approved"` and `channel: "x"` renderings qualify — anything
 * else is either not yet human-approved or was formatted for a different channel entirely, and
 * matching against either would attribute a live post to copy nobody signed off, or to the wrong
 * channel's words. A rendering with empty text is dropped too, since `similarity()` can never score
 * it above 0.
 *
 * **This is the one spelling of that predicate, and every reader of it must use this function.** It
 * used to exist in three: `xMatchCandidates` below, `xTypesFor` in `src/cli/x-reconcile.ts`, and a
 * looser variant inside `reconcileXPublished`'s own `renderingByItemId` loop that checked only the
 * `itemId`. That third one is why a confirmed row could be written under a `type` taken from a
 * *telegram* rendering (or an unapproved one) that merely shared the itemId and happened to come
 * first in `PgFormattingStore.loadAll()`'s `order by ordinal` — a `deliveryKey` `SendChannels.run`
 * does not recognise, so the next `send:channels --target x` read the item as unsent and posted the
 * copy a human had already published by hand. One item routinely becomes several typed renderings
 * (`DEFAULT_CHANNELS_BY_TYPE` sends `announcement`/`explainer`/`casual`/`kol` to Telegram), so that
 * shape is ordinary, not exotic. A second spelling of this filter is a second chance to disagree
 * with it, and disagreement here is a duplicate live post.
 */
export function isXCandidateRendering(r: ChannelRendering): boolean {
  return r.status === "approved" && r.channel === "x" && r.text !== "";
}

/**
 * Narrow approved renderings down to the X-channel copy `classify` can compare a live thread
 * against, via `isXCandidateRendering`.
 *
 * Same shape as `telegramMatchCandidates` for the other channel; lives here (not inline in the
 * caller) so it is unit-testable independent of sheet/gateway wiring.
 */
export function xMatchCandidates(renderings: ChannelRendering[]): MatchCandidate[] {
  return renderings.filter(isXCandidateRendering).map((r) => ({ itemId: r.itemId, text: r.text }));
}

/**
 * Why a thread was reported as a candidate rather than written anywhere. One value per push site in
 * `reconcileXPublished` — named for what happened, not for which `if` produced it, so a person
 * reading the plan knows what to do without reading this module's source:
 *
 * - `"possible-match"` — `classify` itself landed the score in the band between "clearly ours" and
 *   "clearly not" (`CANDIDATE_AT` to `CONFIRMED_AT`): a paste that was then edited, most likely. The
 *   human question is "is this the same post?"
 * - `"duplicate-live-thread"` — two live threads both matched the same itemId within this one run;
 *   the first (oldest, by input order) took the confirmation and this one is the leftover. The human
 *   question is "two posts matched one item — which one is it?"
 * - `"ambiguous-rendering-type"` — more than one eligible rendering shares the matched itemId under
 *   a different `type`, so confirming would risk writing a delivery row under the wrong
 *   `deliveryKey`. The human question is "this item has two `x` renderings; which one is this?"
 */
export type CandidateReason = "possible-match" | "duplicate-live-thread" | "ambiguous-rendering-type";

/**
 * What to do with what is live on the account, given what is already recorded. Never itself
 * written anywhere — the caller loads the sets this was built from and does the actual writing.
 *
 * `confirmed` rows are new `x-post` delivery entries — the pasted copy has an owner. `external`
 * rows are new `kr:`-keyed history entries — the account posted something we did not produce.
 * `candidates` are reported only: a score in the band between "clearly ours" and "clearly not"
 * is a human's call, and writing it under either a `kr:` id or an `x-post` delivery row would
 * leave two rows for one post the moment that human's call disagrees. `skipped` explains, per
 * post, why something that would otherwise have been written was left alone — almost always
 * because a previous run (or a hand-run pipeline) already recorded it.
 *
 * `skipped` is keyed by rootId but is **not** exclusively about this run's live threads. The second
 * pass pushes to it too (Task 4 review round 4), for a settled translation whose own `postedUrl`
 * this run declined to act on: one naming a different account (whose rootId is therefore a post that
 * is not in `threads` at all), one whose post a different item's rendering already claimed, and — a
 * fact rather than an absence — one whose post this run took out of matching **without** writing
 * anything, because releasing it would not have been safe or because an earlier translation had
 * already spoken for it. All are the same kind of fact this list already carries — "a real post,
 * deliberately left alone, and here is why" — and each row's own `reason` says which. The
 * alternative was a silent `continue`, which is how a two-items-one-post conflict that never
 * self-heals stays invisible forever; the alternative to that was a throw, which on an unattended
 * six-hourly timer stops the whole run reconciling anything at all.
 *
 * `candidates` deliberately carries no `type` — only `rootId`/`itemId`/`score`/`reason`. Unlike
 * `confirmed`, nothing is written for a candidate, so there is no `DeliveryEntry` to put a type on;
 * a caller that needs the matched rendering's type can look it up by `itemId` from the same
 * `renderings` it already has.
 *
 * `reason` (see `CandidateReason`) exists because three unrelated situations all produce a
 * `candidate`, and a human acts on each one differently. Reporting them identically would force
 * whoever reads the plan to reverse-engineer which one they're looking at from the score and id
 * alone, and this feature's entire output is a report a person acts on: a row that doesn't say what
 * happened doesn't do its job.
 *
 * `external` carries its `score` alongside the `record`, mirroring `confirmed` — not because the
 * write needs it (`externalHistoryRecord` never reads it back), but because `classify` already did
 * the work of computing a real sub-`CANDIDATE_AT` score for a near-miss (see the "carries the real
 * score on a near-miss" test in `tests/domain/xReconcile.test.ts`, and `MATCH_THRESHOLD`'s
 * `similarity` floor for text under 3 normalized characters), and dropping it here would be the
 * only place that score dies. Without it, three genuinely different situations — no candidates
 * existed, the text was too short for `similarity` to score at all, and a real comparison scored
 * close to zero — collapse into identical rows, and a human reading the plan can no longer tell "a
 * completely unrelated post" apart from "a post that nearly matched something we approved," which
 * is exactly the case worth their attention.
 *
 * `posted` rows are the second pass's output — a translation that never went through the rendering
 * route at all, matched against a live thread by `bestThreadFor`/`TRANSLATION_MATCH_AT` rather than
 * `classify`/`CONFIRMED_AT`, OR a translation already settled (`postedUrl` set) whose history row is
 * still missing, read back via `parsePostUrl` rather than re-scored — see the second pass's own
 * doc comment below. Not a `DeliveryEntry`: a translation never had a `ChannelRendering`, so there
 * is no `type` to put on one and no `x-post` delivery row to write. The caller instead stamps
 * `postedUrl`/`postedAt` onto the `Translation` row itself — see `Translation` in
 * `src/domain/translation/models.ts`.
 *
 * `postedNearMisses` is `posted`'s own near-miss list — a translation the second pass scored (never
 * a settled one; those are never scored at all) above 0 but below `TRANSLATION_MATCH_AT` against its
 * best available thread. Computed here, against the exact pool the pass used at the moment of
 * scoring, rather than left for a caller to reconstruct afterward: a caller re-deriving "which
 * threads were excluded" from `plan.posted` alone cannot see a thread a settled-but-genuinely-done
 * translation claimed without ever appearing in `plan.posted` (Task 4 review round 2, Concern 2) —
 * this is exactly the case that made the report layer's own reconstruction (Task 4 review round 1,
 * Finding 5's fix) wrong again one round later. Same reasoning as `external`'s own carried-through
 * near-miss score, applied to this pass instead of `classify`'s.
 */
export type ReconcilePlan = {
  confirmed: { entry: DeliveryEntry; score: number }[];
  candidates: { rootId: string; itemId: string; score: number; reason: CandidateReason }[];
  external: { record: PublishRecord; score: number }[];
  skipped: { rootId: string; reason: string }[];
  posted: { itemId: string; rootId: string; score: number; url: string; postedAt: string }[];
  postedNearMisses: { itemId: string; rootId: string; score: number }[];
};

/**
 * Decide what to do with each live thread, against the copy we have approved and the rows we have
 * already recorded. Pure: no clock, no I/O, no `process.env` — every timestamp in the plan comes
 * from the thread itself, via `observedDelivery`/`externalHistoryRecord`.
 *
 * Threads are walked in the order given, so the plan (and which thread "wins" a shared itemId, see
 * below) is a function of the input order alone — same input, same plan, every time.
 *
 * Idempotency is two separate checks, and they lead to two different outcomes:
 *
 * - A confirmed match whose `x-post` delivery key is already in `deliveredKeys` is **skipped**.
 *   This is what protects the two pre-existing rows recording real sends to @bcd_kyle: they are
 *   history, and this reconcile must never "correct" their post id to a @0xMantleKR post.
 * - A confirmed match for an itemId this same run already confirmed (two live threads matching one
 *   piece of copy — a re-post, or a near-duplicate) is downgraded to a **candidate** instead: the
 *   first thread in input order keeps the confirmation, and the second is surfaced for a human
 *   rather than silently dropped, since it is still a real live thread that needs an owner.
 *
 * Both are distinct from a *candidate* verdict from `classify`, which is never confirmed and never
 * filed as external — see `ReconcilePlan`.
 *
 * A third thing lands in `skipped`, for a different reason entirely: a thread with no tweet of its
 * own matching its `rootId` — a reply into someone else's thread. It is per-thread and never fatal,
 * so one such reply can no longer take the whole run down with it. See the guard in the loop.
 *
 * `historyIds` and `historyPostIds` are the `history` tab read two ways, and an external thread is
 * skipped if it matches **either**. `kr:<rootId>` in column A only catches rows this reconcile itself
 * wrote; the tab's real identity for an X row is the **postId** in column D, which is what
 * `RecordImpressions` filters on (`channel === "x" && postId`). A live post already recorded under a
 * *different* itemId — by `pnpm history:record --item x:… --post-id …`, the documented manual path for
 * exactly these hand-posts, or by a `send:channels` send whose rendering later stopped being an
 * eligible candidate — would otherwise get a second row for the same post, and `impressions:record`
 * would write view counts into both.
 *
 * A second, separate pass runs after the thread loop above and walks `translations` instead of
 * `threads`: not "whose copy is this live thread?" but "did this translation already go out by
 * hand?" The two questions run in opposite directions — the first pass asks each live thread which
 * approved rendering it is; this one asks each translation which live thread it already is, via
 * `bestThreadFor`/`TRANSLATION_MATCH_AT` (see `xReconcile.ts`) rather than `classify`/`CONFIRMED_AT`,
 * because a translation is compared before it was ever formatted into approved copy and so scores
 * far lower than a copy-paste. Deliberately a second loop, not folded into the first: merging two
 * predicates that ask different questions is exactly how `isXCandidateRendering`'s doc comment says
 * a second spelling of one rule gets written — here that would mean one loop body deciding both "is
 * this thread our approved copy" and "is this thread some translation's hand-post" against two
 * different scoring functions and two different threshold constants, and a future edit to one
 * arm's guard silently applying to the other.
 *
 * **A translation with `postedUrl` already set is never scored — read, not re-matched.** Two rules
 * make that necessary, and neither is optional. First, `postedUrl` alone must not skip it: a run
 * whose status write landed and whose history write failed still owes a history row, so the skip is
 * conjunctive with `historyPostIds`. Second, that retry must not re-run `bestThreadFor`: the original
 * live thread can age out of `--since` between runs, and re-scoring against whatever threads ARE in
 * this run's window can silently pick a *different* thread, attributing the wrong live post to the
 * item and feeding the wrong postId to `impressions:record`. So a settled translation's rootId is
 * read back out of its own `postedUrl` via `parsePostUrl` (see that function's own doc comment) —
 * which also means a retry no longer depends on the original thread being inside the fetch window at
 * all: a history row owed from three weeks ago still gets written today.
 *
 * This pass therefore runs in two phases over `translations`, not one:
 *
 * **Phase A — settled translations** (`postedUrl` already set). This phase makes no decisions of its
 * own. Every translation goes through `settledTranslationDisposition` (a pure function in
 * `xReconcile.ts`, which owns the rules and their reasoning) and the loop below is an exhaustive
 * `switch` over the four things it can answer — `phase-b`, `claim`, `release`, `fail` — with no bare
 * `continue` anywhere. That shape is the point, not decoration: this phase grew six exits over four
 * review rounds and the correctness of every one of them rested on the same question, *does this
 * exit leave a post unclaimed, and is that safe?*, answered in prose per branch. Three separate
 * defects were three wrong answers to it. It is now answered once, by code, inside the disposition
 * function: **a release is legal only when its post is absent from the pool Phase B will score
 * against, or already consumed; otherwise the post is claimed instead.** A new exit cannot get it
 * wrong without being written to bypass that function.
 *
 * That "claimed instead" is deliberately not a `fail`. `x:reconcile` runs unattended every six hours,
 * so throwing does not refuse one item — it reconciles nothing at all, on every tick, until the
 * offending post ages out of a 30-day window. A claim satisfies the same invariant by the strongest
 * available means (the post leaves the pool entirely), writes nothing, and reports the conflict. See
 * `SettledTranslationDisposition` for what is still a `fail` and why.
 *
 * Two things the caller (below, not the disposition function) is responsible for:
 *
 * - **`claim` takes the post out of the pool unconditionally**, whether or not anything is owed. A
 *   settled translation's post is a fact, not a contest, and a DIFFERENT translation must never be
 *   free to match it just because the settled one needed no fresh write. Phase A also runs to
 *   completion before Phase B scores anything, so a settled claim can never lose a race to an
 *   unsettled translation that merely sits earlier in `translations` — the ordering is part of the
 *   guarantee, not just the claim.
 * - **`release`, and any `claim` carrying a `reason`, are always reported** in `plan.skipped`, never
 *   dropped. A settled translation this run does nothing with is invisible otherwise, and every one
 *   of those situations names something that never self-heals (a stale `REFERENCE_X_HANDLE` or a
 *   typo'd `--handle`; one live post that a rendering says is item A and a translation's own
 *   `postedUrl` says is item B; two translations naming one post). Re-derived every tick, they are
 *   only ever fixed by a person seeing them.
 *
 * A `claim` with `retire: true` re-enters `plan.posted` so `RetireTranslation` gets another chance at
 * just the history half — see that class's own doc comment for why re-entering can never re-apply the
 * *status* half: it treats an existing `postedUrl` as `"already-retired"` and never overwrites it, so
 * 되돌리기, a human's correction to `postedUrl`, still sticks.
 *
 * **Phase B — everything else** (`postedUrl` unset). Skipped before ever being scored: if its
 * `itemId` is one `claimedItemIds` already holds from the thread loop above — which covers both an
 * item confirmed in this run and an item whose `x-post` delivery row already existed, the ordinary
 * aftermath of `send:channels`; or if `koreanText` is empty (`similarity` can never score it above
 * 0). A thread is excluded from Phase B's pool for four reasons: it has no root (`findRootTweet`
 * undefined — same guard as the thread loop, for the same reason: there is no `createdAt` to stamp
 * `postedAt` from); it was already turned into a `plan.confirmed` row above — one live post must
 * never become both a delivery row and a translation retire; its item already had an `x-post`
 * delivery row, so the thread loop skipped it (same rule, an older delivery row instead of a new
 * one); or it is already a `plan.candidate` — a human has not yet said which item that thread is,
 * and retiring some other translation against it here would mean that same thread could be confirmed
 * for item A by a human answering the candidate AND silently recorded as item B's retire, with
 * nothing to say the two disagree — **or** it was already claimed in Phase A. A match
 * that clears `TRANSLATION_MATCH_AT` claims its thread (removed from the pool for the rest of this
 * pass — so two translations can never both claim the same live thread; first in input order wins,
 * the same convention `claimedItemIds` already uses above) and is pushed to `plan.posted`. A match
 * that scores above 0 but below the floor is reported in `plan.postedNearMisses` instead (see
 * `ReconcilePlan`'s own doc comment) — not written anywhere, but real information for a human, the
 * same argument `plan.external`'s own carried-through near-miss score already makes.
 *
 * A thread this pass retires is also pruned from `plan.external` after the loop, for the same
 * one-post-one-row reason: a hand-posted translation was never an approved rendering, so the first
 * pass's `classify` never had a candidate for it and correctly filed it as `external` — but it IS
 * this translation's post, and Task 4 writes a history row per `plan.posted` entry the same as it
 * does per `plan.external` entry. Leaving both would write two history rows for one postId, and
 * `impressions:record` (which filters `channel === "x" && postId`) would then measure the same post
 * into both — exactly what the `historyPostIds` guard above exists to prevent across runs, just
 * reached from within this one run instead. Pruning after both passes complete, rather than
 * reordering them, because this pass depends on `plan.confirmed` already being built.
 *
 * Finally, the plan is checked against the one thing every defect in this pass has produced as its
 * symptom: **one live post appearing in two lists.** A rootId in `plan.posted` may not appear twice,
 * may not also be a `plan.confirmed` delivery row, and may not also be one of the second pass's own
 * `plan.skipped` releases. Each of those is a contradiction the plan cannot honestly hold, and the
 * disposition invariant is supposed to make all three unreachable — this is the cheap end-to-end
 * check that it did. Deliberately NOT asserted: `confirmed` ∩ `skipped`, which is the legitimate
 * shape of the `already-consumed` release (a conflict reported *about* a confirmed post), and
 * `posted` ∩ a skip from the thread loop above, which can be an ordinary consequence of an existing
 * history row rather than a contradiction.
 */
export function reconcileXPublished(input: {
  threads: AssembledThread[];
  renderings: ChannelRendering[];
  translations: Translation[];
  deliveredKeys: Set<string>;
  historyIds: Set<string>;
  historyPostIds: Set<string>;
  handle: string;
}): ReconcilePlan {
  const { threads, renderings, translations, deliveredKeys, historyIds, historyPostIds, handle } = input;

  // ONE list, filtered ONCE by `isXCandidateRendering`, feeding all three things derived from it:
  // the match candidates, the itemId → rendering lookup a confirmed verdict takes its `type` from,
  // and the per-itemId occurrence count the ambiguity guard reads. Deriving any of them from the
  // full `renderings` list instead is the defect this shape exists to make unrepresentable — see
  // `isXCandidateRendering`'s own doc comment for what it cost.
  const eligible = renderings.filter(isXCandidateRendering);
  const candidates = xMatchCandidates(eligible); // filters again, a no-op by construction: one map, one predicate.

  // First-wins on a duplicate itemId, matching `bestMatch`'s own tie-break convention (first
  // candidate in input order — see attribution.ts) rather than `Map`'s default last-write-wins.
  // `ChannelRendering`'s identity is (itemId, type, channel), and two approved `channel: "x"`
  // renderings sharing an itemId but differing in `type` is reachable TODAY, not just in principle:
  // `FormatVariants`/`PrepareRefinements` both do `selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type]`,
  // and that `channels` override is exposed on the CLI (`--channels`) and the API, so formatting a
  // non-"x"-typed variant with a `channels: ["x"]` override produces exactly this. Which rendering
  // this Map hands back is then a convention, not evidence — see the ambiguity guard below, which is
  // why picking the wrong one here is never allowed to reach a write.
  const renderingByItemId = new Map<string, ChannelRendering>();
  for (const r of eligible) {
    if (!renderingByItemId.has(r.itemId)) renderingByItemId.set(r.itemId, r);
  }

  // How many eligible (approved, channel "x", non-empty) renderings share an itemId. Almost always
  // 1. When it is more than 1, `renderingByItemId`'s first-wins pick is a convention, not evidence
  // — `classify` only proves the itemId, never which of the sharing renderings' `type`s is right —
  // so a confirmed verdict for that itemId must not reach a write; see the guard below. Counted off
  // `eligible`, the same list `renderingByItemId` was built from, so the guard can never read 1 for
  // a map that had a choice to make.
  const itemIdOccurrences = new Map<string, number>();
  for (const r of eligible) {
    itemIdOccurrences.set(r.itemId, (itemIdOccurrences.get(r.itemId) ?? 0) + 1);
  }

  const plan: ReconcilePlan = { confirmed: [], candidates: [], external: [], skipped: [], posted: [], postedNearMisses: [] };
  const claimedItemIds = new Set<string>();

  // rootIds the thread loop took out of play WITHOUT leaving a row in `plan.confirmed` or
  // `plan.candidates` — specifically, a thread whose matched item ALREADY carries an `x-post`
  // delivery row (`deliveredKeys`). `consumedRootIds` below is otherwise derived from the plan, which
  // is drift-proof for every push site but blind to a skip, and that blindness was a defect: the
  // delivered thread stayed in Phase B's pool and a completely unrelated translation could be retired
  // against it, producing an `x:<other>` history row carrying a postId that already has a delivery
  // row for someone else — and `impressions:record` then measures the post into both. Kept as its own
  // set rather than folded into `plan.skipped` because `plan.skipped` holds rows from four unrelated
  // causes (rootless threads, external posts already in history, Phase A releases) and only this one
  // means "the rendering route owns this post."
  const recordedRootIds = new Set<string>();

  for (const thread of threads) {
    // A thread with no tweet of its own matching its `rootId` has two distinct causes, and this
    // guard cannot tell which one it is looking at:
    //
    //  1. A reply the account made into SOMEONE ELSE'S thread: `assembleThreads` keys on
    //     `conversationId || id` and `conversationId` is the root's id, so the root belongs to an
    //     account `fetchAuthoredTweets(handle)` never returns. No amount of gap-filling can produce
    //     a tweet nobody but that other account authored. This is the common case — 85 of the 196
    //     @Mantle_Official threads in the committed corpus have it, all one-tweet replies.
    //  2. The root IS ours, but simply fell outside this run's `--since` window. This is the shape
    //     `CollectAuthoredContent.gapFillMissingRoots` exists to repair — and `x:reconcile`
    //     deliberately never calls it (see `x-reconcile.ts`'s own read of the timeline, which reads
    //     the account back for comparison only). A genuine multi-tweet post of ours straddling the
    //     boundary lands here too, and re-running with a wider `--since` is the fix, not a code
    //     change.
    //
    // Skipped, not thrown: `externalHistoryRecord`/`observedDelivery` both stamp
    // postId/url/publishedAt from the root, so without this guard one reply to a partner account
    // threw out of plan building — no per-thread try/catch anywhere — and `registerErrorHandler`
    // exited 1, reconciling NOTHING and re-failing every six hours until the reply aged past
    // `--since` (30 days on the unit).
    //
    // And skipped rather than fallen back to `tweets[0]`, which would be worse than the crash: the
    // row would carry another account's tweet id as `postId`, behind a
    // `https://x.com/<handle>/status/<their-id>` url that `impressions:record` then measures.
    if (findRootTweet(thread) === undefined) {
      plan.skipped.push({
        rootId: thread.rootId,
        reason:
          `root tweet ${thread.rootId} is missing from @${handle}'s own timeline — either this is ` +
          `a reply into someone else's thread, or it is ours and simply fell outside --since; ` +
          `re-run with a wider --since if you expected this one to be ours`,
      });
      continue;
    }

    const verdict = classify(thread, candidates);

    if (verdict.kind === "confirmed" || verdict.kind === "candidate") {
      const rendering = renderingByItemId.get(verdict.itemId);
      if (rendering === undefined) {
        // classify only ever returns an itemId drawn from `candidates`, and every candidate's
        // itemId is a key of renderingByItemId — reaching here is a bug worth failing on.
        throw new Error(`classify matched itemId ${verdict.itemId}, which is not one of the x renderings given`);
      }

      if (verdict.kind === "candidate") {
        // classify itself landed in the middle band — see CandidateReason's "possible-match".
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score, reason: "possible-match" });
        continue;
      }

      if ((itemIdOccurrences.get(verdict.itemId) ?? 0) > 1) {
        // More than one approved x rendering shares this itemId under a different `type` — reachable
        // today via a --channels/API override, see the comment above `renderingByItemId`. `type` is
        // part of `deliveryKey`, so confirming on the wrong one writes a delivery row under the wrong
        // key: `send:channels` would still see the real (itemId, type, x-post) as unsent and post it
        // again — the exact duplicate this feature exists to prevent — and a `sent` row is never
        // reversed. Refusing and reporting a candidate costs one human confirmation instead.
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score, reason: "ambiguous-rendering-type" });
        continue;
      }

      const key = deliveryKey({ itemId: verdict.itemId, type: rendering.type, outletId: "x-post" });
      if (deliveredKeys.has(key)) {
        // Already recorded — by this reconcile on an earlier run, by `send:channels`, or by hand. The
        // itemId is genuinely done, so nothing is written and no human needs to look at it: skipped.
        //
        // But it is consumed **exactly as a fresh confirmation is**, and both halves are load-bearing
        // — this used to `continue` having claimed nothing, which left two holes in the second pass:
        //
        //  - The post stayed in Phase B's pool, so an unrelated translation could be retired against
        //    a post that already carries an `x-post` delivery row for a different item. That writes
        //    an `x:<other>` publish-history row for this postId on top of the existing delivery row,
        //    and `impressions:record` (which filters `channel === "x" && postId`) then measures the
        //    same live post into both. `assertOnePostOneRow` cannot catch it: it deliberately
        //    excludes thread-loop skips, because a skip sharing a rootId with a retire is an ordinary
        //    outcome for the OTHER skip reasons.
        //  - The item stayed out of `claimedItemIds`, so its OWN translation was still scored in
        //    Phase B. That one is not a corner case, it is the guaranteed steady state: after any
        //    successful `send:channels --target x`, the live post IS this item's translation, so the
        //    very next tick scored ~1.0 against it and silently flipped the translation to `posted` —
        //    removing an item from 1차 검수 with nobody looking, for the most ordinary send there is.
        claimedItemIds.add(verdict.itemId);
        recordedRootIds.add(thread.rootId);
        plan.skipped.push({ rootId: thread.rootId, reason: `${verdict.itemId} already has an x-post delivery row` });
        continue;
      }
      if (claimedItemIds.has(verdict.itemId)) {
        // Not yet recorded anywhere — a second live thread matched the same itemId within this
        // same run (a re-post or near-duplicate). The first (oldest, by input order) thread already
        // claimed the confirmation; this one is genuinely ambiguous, not done, so it is reported as
        // a candidate ("duplicate-live-thread") for a human to judge rather than silently dropped.
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score, reason: "duplicate-live-thread" });
        continue;
      }

      claimedItemIds.add(verdict.itemId);
      plan.confirmed.push({ entry: observedDelivery(verdict.itemId, rendering.type, thread, handle), score: verdict.score });
      continue;
    }

    // external
    const itemId = `kr:${thread.rootId}`;
    if (historyIds.has(itemId)) {
      plan.skipped.push({ rootId: thread.rootId, reason: `${itemId} already in publish history` });
      continue;
    }
    if (historyPostIds.has(thread.rootId)) {
      // Same live post, already recorded under some other itemId — the `history` tab's real identity
      // for an X row is its postId, not its itemId. Writing `kr:<rootId>` anyway would leave two rows
      // for one post, and `RecordImpressions` (which filters on `channel === "x" && postId`) would
      // then measure the same post into both of them.
      plan.skipped.push({
        rootId: thread.rootId,
        reason: `post ${thread.rootId} already in publish history under a different itemId`,
      });
      continue;
    }
    plan.external.push({ record: externalHistoryRecord(thread, handle), score: verdict.score });
  }

  // Second pass: walk translations, not threads — see the doc comment above for why this is a
  // separate loop rather than folded into the one above, and for why it is now two PHASES rather
  // than one, run in order (Phase A to completion before Phase B starts).
  //
  // Rootless threads are never a candidate here (no root, no createdAt to stamp `postedAt` from —
  // same reason the thread loop skips them). Neither is a thread this run already turned into a
  // `plan.confirmed` delivery row (one live post must never become both a delivery row and a
  // retire), nor one already sitting in `plan.candidates` (a human has not yet said which item that
  // thread is — see the doc comment above for what confirming it later while it is also silently
  // retired here would do).
  //
  // A third exclusion, from `recordedRootIds`: a thread whose item already carries an `x-post`
  // delivery row. It leaves no row in `plan.confirmed`/`plan.candidates` to derive it from, so it is
  // carried out of the loop explicitly — see that set's own comment for what leaving it in the pool
  // cost.
  const consumedRootIds = new Set(
    [...plan.confirmed.map((c) => c.entry.postId), ...plan.candidates.map((c) => c.rootId), ...recordedRootIds].filter(
      // `DeliveryEntry.postId` is optional in the type; `observedDelivery` always sets it, so this
      // drops nothing in practice — it keeps the set a `Set<string>` so the disposition function can
      // take it as one, rather than a `Set<string | undefined>` whose `undefined` member could never
      // match a rootId anyway.
      (id): id is string => id !== undefined,
    ),
  );
  const availableThreads = threads.filter((t) => findRootTweet(t) !== undefined && !consumedRootIds.has(t.rootId));

  // The set that makes Phase A's release invariant checkable: exactly the posts this run could still
  // hand to some other translation. Computed once, before Phase A runs, and never narrowed as claims
  // happen — a release is illegal if the post was EVER available to Phase B, not merely if it is
  // still available by the time this particular translation is looked at.
  const poolRootIds = new Set(availableThreads.map((t) => t.rootId));

  // Threads this pass has claimed — by Phase A reading an already-settled translation's own record,
  // or by Phase B scoring a fresh match. Removed from the pool as they're claimed, so no later
  // translation in either phase can see them — the same "first in input order wins" convention
  // `claimedItemIds` uses above, applied to threads instead of itemIds, with Phase A's claims always
  // winning regardless of input order.
  const claimedRootIds = new Set<string>();

  // The rootIds THIS pass released (as opposed to the thread loop's own skips, which mean different
  // things). Kept for the post-condition below: a post this pass declared "left alone" must never
  // also be a post it retired.
  const releasedRootIds = new Set<string>();

  // Every rootId Phase A has resolved, whichever way it went. `claimedRootIds` and `releasedRootIds`
  // above each answer a narrower question (what Phase B may still score; what the post-condition must
  // not see retired); this one answers "has an earlier settled translation already spoken for this
  // post at all?", which is what stops two translations naming one post from producing two rows.
  const settledRootIds = new Set<string>();

  // Phase A — settled translations (`postedUrl` already set). Read, never scored. Every decision
  // belongs to `settledTranslationDisposition`; this loop only carries them out, exhaustively.
  for (const translation of translations) {
    const disposition = settledTranslationDisposition(translation, {
      handle,
      poolRootIds,
      consumedRootIds,
      claimedItemIds,
      historyPostIds,
      settledRootIds,
    });

    switch (disposition.kind) {
      case "phase-b":
        break; // not settled — the loop below scores it. Deliberately `break`, not `continue`: no exit here is bare.

      case "claim":
        claimedRootIds.add(disposition.rootId);
        settledRootIds.add(disposition.rootId);
        if (disposition.retire) {
          plan.posted.push({
            itemId: translation.itemId,
            rootId: disposition.rootId,
            score: 1, // not a fresh match this run — this translation's own already-established record
            url: disposition.url,
            postedAt: disposition.postedAt,
          });
        } else if (disposition.reason !== undefined) {
          // A claim that writes nothing but resolved a conflict — an unsafe release converted to a
          // claim, or a second translation naming a post the first already took. Reported for the
          // same reason a release is: nothing here self-heals, so a run that says nothing means
          // nobody ever fixes it. See `SettledTranslationDisposition` for why this is not a throw.
          plan.skipped.push({ rootId: disposition.rootId, reason: disposition.reason });
        }
        break;

      case "release":
        // Reported, never dropped — see the doc comment above. The post is guaranteed not to be in
        // Phase B's pool (or to be consumed already), because `settledTranslationDisposition` turns
        // any release that would not be into a `fail`.
        plan.skipped.push({ rootId: disposition.rootId, reason: disposition.reason });
        releasedRootIds.add(disposition.rootId);
        settledRootIds.add(disposition.rootId);
        break;

      case "fail":
        throw new Error(disposition.message);

      default: {
        const unreachable: never = disposition;
        throw new Error(`reconcileXPublished: unhandled settled-translation disposition ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // Phase B — everything else (`postedUrl` unset), scored against whatever Phase A left available.
  for (const translation of translations) {
    if (translation.postedUrl !== undefined) continue; // handled in Phase A
    if (claimedItemIds.has(translation.itemId)) continue; // the rendering route already confirmed this item this run
    if (translation.koreanText === "") continue; // similarity() can never score this above 0

    const pool = availableThreads.filter((t) => !claimedRootIds.has(t.rootId));
    const match = bestThreadFor(translation.koreanText, pool);
    if (match === undefined) continue;

    if (match.score < TRANSLATION_MATCH_AT) {
      if (match.score > 0) {
        // Real information, not nothing — see `ReconcilePlan`'s own doc comment on
        // `postedNearMisses` for why this is reported rather than dropped.
        plan.postedNearMisses.push({ itemId: translation.itemId, rootId: match.thread.rootId, score: match.score });
      }
      continue;
    }

    const root = findRootTweet(match.thread);
    if (root === undefined) continue; // unreachable: availableThreads is pre-filtered to threads with a root

    claimedRootIds.add(match.thread.rootId);
    plan.posted.push({
      itemId: translation.itemId,
      rootId: match.thread.rootId,
      score: match.score,
      url: postUrl(handle, match.thread.rootId),
      postedAt: root.createdAt,
    });
  }

  // A thread this pass just retired was, by construction, never an approved rendering (`classify`
  // had no candidate for it), so the first pass correctly filed it under `plan.external` as
  // `kr:<rootId>` before this pass ever ran. Now that it has an owner, that `external` row must not
  // survive — see the doc comment above for why leaving both would double-record the same postId in
  // history. Pruned here, once, after both passes are done, rather than checked inline in either
  // loop, so there is exactly one place this rule is spelled out.
  const retiredRootIds = new Set(plan.posted.map((p) => p.rootId));
  plan.external = plan.external.filter((e) => e.record.postId === undefined || !retiredRootIds.has(e.record.postId));

  assertOnePostOneRow(plan, releasedRootIds);

  return plan;
}

/**
 * The plan's one structural post-condition: **a post this run retired appears in exactly one list.**
 *
 * Every defect this pass has had — across four review rounds — produced the same symptom, one live
 * post named by two rows of one plan: retired for item B while confirmed for item A, retired while
 * simultaneously reported as left alone, or retired twice. Phase A's release invariant (see
 * `settledTranslationDisposition`) is what makes each of those unreachable; this is the cheap check
 * that it actually did, stated in terms of the output a human reads rather than of the internal sets.
 *
 * Scoped deliberately. `releasedRootIds` is the second pass's OWN skips, not all of `plan.skipped`:
 * `confirmed` ∩ `skipped` is the legitimate shape of an `already-consumed` release (a conflict
 * reported *about* a confirmed post, which is the whole point of reporting it), and a thread-loop
 * skip sharing a rootId with `posted` — a post already carrying a history row under another itemId,
 * say — is an ordinary outcome rather than a contradiction. Asserting those would be asserting a
 * shape this plan was never supposed to have.
 *
 * Throws rather than reporting: reaching it means the plan is internally inconsistent, so there is no
 * subset of it a caller could safely write.
 */
function assertOnePostOneRow(plan: ReconcilePlan, releasedRootIds: ReadonlySet<string>): void {
  const confirmedRootIds = new Set(plan.confirmed.map((c) => c.entry.postId).filter((id): id is string => id !== undefined));
  const seen = new Set<string>();

  for (const { rootId, itemId } of plan.posted) {
    const clash = seen.has(rootId)
      ? "another plan.posted row"
      : confirmedRootIds.has(rootId)
        ? "a plan.confirmed delivery row"
        : releasedRootIds.has(rootId)
          ? "a plan.skipped row this pass released"
          : undefined;
    if (clash !== undefined) {
      throw new Error(
        `reconcileXPublished: post ${rootId} is retired for ${itemId} and is also ${clash} — one live ` +
          `post, two rows in one plan; refusing to hand a caller a plan that contradicts itself`,
      );
    }
    seen.add(rootId);
  }
}
