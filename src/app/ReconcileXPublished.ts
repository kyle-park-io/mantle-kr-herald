import {
  bestThreadFor,
  classify,
  externalHistoryRecord,
  findRootTweet,
  observedDelivery,
  postUrl,
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
 * thread, why a live post that would otherwise have been written was left alone — almost always
 * because a previous run (or a hand-run pipeline) already recorded it.
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
 * `classify`/`CONFIRMED_AT`. Not a `DeliveryEntry`: a translation never had a `ChannelRendering`, so
 * there is no `type` to put on one and no `x-post` delivery row to write. The caller instead stamps
 * `postedUrl`/`postedAt` onto the `Translation` row itself — see `Translation` in
 * `src/domain/translation/models.ts`.
 */
export type ReconcilePlan = {
  confirmed: { entry: DeliveryEntry; score: number }[];
  candidates: { rootId: string; itemId: string; score: number; reason: CandidateReason }[];
  external: { record: PublishRecord; score: number }[];
  skipped: { rootId: string; reason: string }[];
  posted: { itemId: string; rootId: string; score: number; url: string; postedAt: string }[];
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
 * A translation is skipped before ever being scored: if its `itemId` is one `claimedItemIds`
 * already holds from the thread loop above (that item has a real delivery row this run, which is
 * the stronger record — it carries a `type` and passed 2차 검수); or if `koreanText` is empty
 * (`similarity` can never score it above 0). A thread is excluded from this pass's candidates for
 * three reasons: it has no root (`findRootTweet` undefined — same guard as the thread loop, for the
 * same reason: there is no `createdAt` to stamp `postedAt` from); it was already turned into a
 * `plan.confirmed` row above — one live post must never become both a delivery row and a
 * translation retire; or it is already a `plan.candidate` — a human has not yet said which item
 * that thread is, and retiring some other translation against it here would mean that same thread
 * could be confirmed for item A by a human answering the candidate AND silently recorded as item
 * B's retire, with nothing to say the two disagree.
 *
 * `postedUrl` already being set does **not** skip the match — deliberately, since Task 4 review
 * found the original design (skip unconditionally) self-contradictory: it also promised "a failing
 * history write leaves the translation retired and the next run retrying," which was impossible if
 * a retried translation could never re-enter this pass at all. Once a translation is matched, the
 * check is **conjunctive**: skipped only when `postedUrl` is already set **and** the matched
 * thread's `rootId` is already in `historyPostIds` — i.e. genuinely done on both halves. A
 * translation whose `postedUrl` is set but whose matched thread is still missing from
 * `historyPostIds` (its history write threw on some earlier run) is pushed to `plan.posted` again,
 * so `RetireTranslation` gets another chance at just that half; see that class's own doc comment for
 * why re-entering here can never re-apply the *status* half — `RetireTranslation` treats an existing
 * `postedUrl` as `"already-retired"` and never overwrites it, so 되돌리기 (a human's correction to
 * `postedUrl`) still sticks even though the match runs again. A match that is actually pushed to
 * `plan.posted` removes its thread from the pool for the rest of this pass, so two translations can
 * never both claim the same live thread; first in input order wins, the same convention
 * `claimedItemIds` already uses above. A match that is skipped because it is genuinely done on both
 * halves does **not** remove its thread — nothing is claiming it — which is also what keeps
 * `claimedRootIds`'s final state exactly `plan.posted`'s rootIds, the invariant
 * `translationNearMisses` (`src/cli/xReconcileReport.ts`) relies on to reconstruct this pass's
 * excluded-thread set without this function exporting it separately.
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

  const plan: ReconcilePlan = { confirmed: [], candidates: [], external: [], skipped: [], posted: [] };
  const claimedItemIds = new Set<string>();

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
        // Already recorded — by this reconcile on an earlier run, or by hand. The itemId is
        // genuinely done, so this is a no-op, not something a human needs to look at: skipped.
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
  // separate loop rather than folded into the one above.
  //
  // Rootless threads are never a candidate here (no root, no createdAt to stamp `postedAt` from —
  // same reason the thread loop skips them). Neither is a thread this run already turned into a
  // `plan.confirmed` delivery row (one live post must never become both a delivery row and a
  // retire), nor one already sitting in `plan.candidates` (a human has not yet said which item that
  // thread is — see the doc comment above for what confirming it later while it is also silently
  // retired here would do).
  const consumedRootIds = new Set([
    ...plan.confirmed.map((c) => c.entry.postId),
    ...plan.candidates.map((c) => c.rootId),
  ]);
  const availableThreads = threads.filter((t) => findRootTweet(t) !== undefined && !consumedRootIds.has(t.rootId));

  // Threads this pass has already handed to an earlier (in input order) translation. Removed from
  // the pool as they're claimed, so a later translation's `bestThreadFor` call can only see what's
  // left — the same "first in input order wins" convention `claimedItemIds` uses above, applied to
  // threads instead of itemIds.
  const claimedRootIds = new Set<string>();

  for (const translation of translations) {
    if (claimedItemIds.has(translation.itemId)) continue; // the rendering route already confirmed this item this run
    if (translation.koreanText === "") continue; // similarity() can never score this above 0

    const pool = availableThreads.filter((t) => !claimedRootIds.has(t.rootId));
    const match = bestThreadFor(translation.koreanText, pool);
    if (match === undefined || match.score < TRANSLATION_MATCH_AT) continue;

    const root = findRootTweet(match.thread);
    if (root === undefined) continue; // unreachable: availableThreads is pre-filtered to threads with a root

    if (translation.postedUrl !== undefined && historyPostIds.has(match.thread.rootId)) {
      // Genuinely done on both halves: retired in an earlier run, and its history row is already
      // on the sheet. See the function doc comment above for why `postedUrl` alone does not skip —
      // this conjunctive check is what makes a stuck history write retryable without ever letting
      // the match re-decide which post a translation is. Not claimed: this translation isn't
      // taking the thread anywhere (nothing is pushed to `plan.posted` for it), so leaving the
      // thread available keeps `claimedRootIds`'s end state exactly `plan.posted`'s rootIds — the
      // invariant `translationNearMisses` (xReconcileReport.ts) relies on to reconstruct the same
      // excluded-thread set this pass used, without this function having to export it separately.
      continue;
    }

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

  return plan;
}
