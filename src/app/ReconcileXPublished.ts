import { classify, externalHistoryRecord, findRootTweet, observedDelivery } from "../domain/publish/xReconcile";
import type { MatchCandidate } from "../domain/kol/attribution";
import type { AssembledThread } from "../domain/models";
import type { ChannelRendering } from "../domain/formatting/models";
import type { DeliveryEntry } from "../domain/delivery/models";
import { deliveryKey } from "../domain/delivery/models";
import type { PublishRecord } from "../domain/sheet/models";

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
 */
export type ReconcilePlan = {
  confirmed: { entry: DeliveryEntry; score: number }[];
  candidates: { rootId: string; itemId: string; score: number; reason: CandidateReason }[];
  external: { record: PublishRecord; score: number }[];
  skipped: { rootId: string; reason: string }[];
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
 */
export function reconcileXPublished(input: {
  threads: AssembledThread[];
  renderings: ChannelRendering[];
  deliveredKeys: Set<string>;
  historyIds: Set<string>;
  handle: string;
}): ReconcilePlan {
  const { threads, renderings, deliveredKeys, historyIds, handle } = input;

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

  const plan: ReconcilePlan = { confirmed: [], candidates: [], external: [], skipped: [] };
  const claimedItemIds = new Set<string>();

  for (const thread of threads) {
    // A thread with no tweet of its own matching its `rootId` is a reply the account made into
    // SOMEONE ELSE'S thread: `assembleThreads` keys on `conversationId || id` and `conversationId`
    // is the root's id, so the root belongs to an account `fetchAuthoredTweets(handle)` never
    // returns. This is common, not exceptional — `CollectAuthoredContent.gapFillMissingRoots` exists
    // for it, and 85 of the 196 @Mantle_Official threads in the committed corpus have it.
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
          `root tweet ${thread.rootId} is not among @${handle}'s own posts — this is a reply into ` +
          `someone else's thread, so there is no post of ours to record`,
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
    plan.external.push({ record: externalHistoryRecord(thread, handle), score: verdict.score });
  }

  return plan;
}
