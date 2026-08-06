/**
 * Reconcile what is live on @0xMantleKR with the copy we approved.
 *
 * Three routes lead to a published post — the full pipeline, a partial run finished by hand, and
 * copy written entirely outside the system — and only the first leaves a trace in our records. So
 * reading the account back is the only way to know what actually went out. This module is the pure
 * decision layer: given a live thread and the set of copy we have approved, decide whether they are
 * the same thing.
 *
 * This is a different question from `src/domain/kol/attribution.ts`'s `bestMatch`: that module asks
 * "which of our campaigns is this KOL echoing?" — topical, deliberately loose, a suggestion a human
 * always confirms. This asks "is this literally the copy we approved?" A copy-paste scores near 1.0
 * under `similarity` (it strips URLs, emoji, and whitespace before taking Jaccard over character
 * 3-grams), so the bands below sit far higher than `MATCH_THRESHOLD`.
 *
 * Pure domain: no clock, no environment, no I/O. Every timestamp comes from the thread given to it.
 */

import { similarity, type MatchCandidate } from "../kol/attribution";
import type { AssembledThread, SourceTweet } from "../models";
import type { PublishRecord } from "../sheet/models";
import type { DeliveryEntry } from "../delivery/models";

/**
 * Score at or above which a live thread is treated as the same copy we approved, not merely related
 * to it. There is no measured true positive to calibrate against — no approved rendering has ever
 * been posted to this account — and identical text scores 1.0 by construction, so this sits high
 * enough that only a copy-paste (or something indistinguishable from one) clears it. Set above the
 * one real measurement available (an unrelated post scoring 0.350) by a wide margin: being wrong
 * high only demotes a real match to a candidate, costing one human confirmation; being wrong low
 * writes an irreversible `sent` row for a post that may not be ours.
 */
export const CONFIRMED_AT = 0.95;

/**
 * Score at or above which a live thread is worth a human's attention, even though it does not clear
 * `CONFIRMED_AT`. The only real measurement — the 0.350 false positive against an unrelated post —
 * must land below this floor, so it is set well above 0.350. Below this floor a thread is `external`
 * and never costs anyone a confirmation; at or above it, a `sent` row is never written on a guess —
 * the verdict is reported and a human decides.
 */
export const CANDIDATE_AT = 0.5;

export type Verdict =
  | { kind: "confirmed" | "candidate"; itemId: string; score: number }
  | { kind: "external"; score: number };

/**
 * The text of a thread as one block, in the order `tweets` already holds (chronological — see
 * `AssembledThread` in `src/domain/models.ts`). Approved copy is written as a single piece, so a
 * thread's replies must be joined the same way or a real match would score every thread external.
 */
export function threadText(thread: AssembledThread): string {
  return thread.tweets.map((t) => t.text).join("\n\n");
}

/**
 * Decide whether a live thread is the copy we approved, a candidate worth a human's attention, or
 * unrelated to anything we produced. Bands on the best score against `candidates`; a thread with no
 * candidates at all is `external` with score 0.
 *
 * Deliberately does **not** call `bestMatch`: that helper ends by discarding any score below
 * `MATCH_THRESHOLD` (0.3), returning `undefined` — the right call for the KOL matcher, which only
 * ever wants to *suggest* a match and has nothing useful to say below its own floor, but wrong here.
 * This feature's whole reason for carrying its own constants is that a near-miss score below 0.3 is
 * still real information (see `Verdict`'s `external` case, and `ReconcileXPublished.ts`'s
 * `ReconcilePlan.external`, which reports it to a human): a live thread that scored 0.26 against our
 * copy is a materially different situation from one with nothing to compare against at all, and
 * `bestMatch` collapses both to the same "no match" signal. So `classify` scores every candidate
 * directly with `similarity` and bands the real number itself, keeping `bestMatch`'s own tie-break
 * convention — first candidate in input order wins a tie — since `ReconcileXPublished.ts`'s
 * `renderingByItemId` depends on that convention holding here too.
 */
export function classify(thread: AssembledThread, candidates: MatchCandidate[]): Verdict {
  const text = threadText(thread);

  let best: { itemId: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = similarity(text, candidate.text);
    if (best === undefined || score > best.score) {
      best = { itemId: candidate.itemId, score };
    }
  }

  if (best === undefined) return { kind: "external", score: 0 };

  if (best.score >= CONFIRMED_AT) return { kind: "confirmed", itemId: best.itemId, score: best.score };
  if (best.score >= CANDIDATE_AT) return { kind: "candidate", itemId: best.itemId, score: best.score };
  return { kind: "external", score: best.score };
}

/** The public URL of a post on `handle`'s account. */
export function postUrl(handle: string, rootId: string): string {
  return `https://x.com/${handle}/status/${rootId}`;
}

/**
 * The tweet whose id is the thread's `rootId`, or `undefined` when this thread has none.
 *
 * That absence is not a bug and not rare. `assembleThreads` keys a thread on
 * `conversationId || id` and `conversationId` is the *root's* id, so any reply the account made into
 * **someone else's** thread produces a thread whose root belongs to an account
 * `fetchAuthoredTweets(handle)` never returns. `CollectAuthoredContent.gapFillMissingRoots` exists
 * for exactly this shape, and 85 of the 196 @Mantle_Official threads in the committed corpus have
 * it — all one-tweet replies.
 *
 * Exported so `ReconcileXPublished.ts` can ask the question with the *same* spelling the two record
 * builders below answer it with, rather than re-deriving "does this thread have its own root?" and
 * risking the two disagreeing.
 */
export function findRootTweet(thread: AssembledThread): SourceTweet | undefined {
  return thread.tweets.find((t) => t.id === thread.rootId);
}

/**
 * The root tweet of an assembled thread. Found by id rather than assumed to be `tweets[0]`, and
 * throws if absent, because at *this* level there is no honest answer: both callers below stamp
 * `postId`/`publishedAt`/`url` from the root, and falling back to `tweets[0]` would put another
 * account's tweet id in `postId` behind a `https://x.com/<us>/status/<their-id>` url that
 * `impressions:record` would then go and measure.
 *
 * Callers that walk many threads must therefore ask `findRootTweet` first and route a rootless
 * thread somewhere that writes nothing — `reconcileXPublished` skips it with a reason. The throw
 * stays here for the case it is actually right for: a caller that built a thread by hand and got it
 * wrong.
 */
function rootTweet(thread: AssembledThread) {
  const root = findRootTweet(thread);
  if (root === undefined) {
    throw new Error(`thread ${thread.rootId} has no tweet matching its own root id`);
  }
  return root;
}

/**
 * A history row for a thread that is live on the account but is not any of our approved copy. Keyed
 * `kr:<rootId>` — never `x:<...>` — because `src/adapters/content/xArticleMeta.ts` short-circuits on
 * ids that do not start with `x:`, and that short-circuit is the protection: a `kr:` id can never
 * trigger a lookup for a source post that does not exist. One row per thread, keyed on the root.
 */
export function externalHistoryRecord(thread: AssembledThread, handle: string): PublishRecord {
  const root = rootTweet(thread);
  return {
    itemId: `kr:${thread.rootId}`,
    type: "x",
    channel: "x",
    outletId: "x-post",
    postId: thread.rootId,
    url: postUrl(handle, thread.rootId),
    status: "posted",
    publishedAt: root.createdAt,
  };
}

/**
 * A delivery row for a thread confirmed to be the copy behind `itemId`. `status: "sent"` because
 * this is an observation — the post is live, read back off the account — never a human's revocable
 * claim (see `src/domain/delivery/models.ts`). `by: "manual"` because a human pasted it; a machine
 * only noticed.
 */
export function observedDelivery(itemId: string, type: string, thread: AssembledThread, handle: string): DeliveryEntry {
  const root = rootTweet(thread);
  return {
    itemId,
    type,
    outletId: "x-post",
    status: "sent",
    at: root.createdAt,
    by: "manual",
    postId: thread.rootId,
    url: postUrl(handle, thread.rootId),
  };
}
