import { classify, externalHistoryRecord, observedDelivery } from "../domain/publish/xReconcile";
import type { MatchCandidate } from "../domain/kol/attribution";
import type { AssembledThread } from "../domain/models";
import type { ChannelRendering } from "../domain/formatting/models";
import type { DeliveryEntry } from "../domain/delivery/models";
import { deliveryKey } from "../domain/delivery/models";
import type { PublishRecord } from "../domain/sheet/models";

/**
 * Narrow approved renderings down to the X-channel copy `classify` can compare a live thread
 * against. Only `status: "approved"` and `channel: "x"` renderings qualify — anything else is
 * either not yet human-approved or was formatted for a different channel entirely, and matching
 * against either would attribute a live post to copy nobody signed off, or to the wrong channel's
 * words. A rendering with empty text is dropped too, since `similarity()` can never score it above 0.
 *
 * Same shape as `telegramMatchCandidates` for the other channel; lives here (not inline in the
 * caller) so it is unit-testable independent of sheet/gateway wiring.
 */
export function xMatchCandidates(renderings: ChannelRendering[]): MatchCandidate[] {
  return renderings
    .filter((r) => r.status === "approved" && r.channel === "x" && r.text !== "")
    .map((r) => ({ itemId: r.itemId, text: r.text }));
}

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
 * `candidates` deliberately carries no `type` — only `rootId`/`itemId`/`score`. Unlike `confirmed`,
 * nothing is written for a candidate, so there is no `DeliveryEntry` to put a type on; a caller that
 * needs the matched rendering's type can look it up by `itemId` from the same `renderings` it
 * already has.
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
  candidates: { rootId: string; itemId: string; score: number }[];
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
 */
export function reconcileXPublished(input: {
  threads: AssembledThread[];
  renderings: ChannelRendering[];
  deliveredKeys: Set<string>;
  historyIds: Set<string>;
  handle: string;
}): ReconcilePlan {
  const { threads, renderings, deliveredKeys, historyIds, handle } = input;

  const candidates = xMatchCandidates(renderings);
  // Looked up by the itemIds `xMatchCandidates` actually kept (not the full `renderings` list), so
  // a confirmed verdict's `type` comes from the rendering it matched against — a rendering carries
  // the type it was formatted for, never a literal.
  //
  // First-wins on a duplicate itemId, matching `bestMatch`'s own tie-break convention (first
  // candidate in input order — see attribution.ts) rather than `Map`'s default last-write-wins.
  // `ChannelRendering`'s identity is (itemId, type, channel), and two approved `channel: "x"`
  // renderings sharing an itemId but differing in `type` is reachable TODAY, not just in principle:
  // `FormatVariants`/`PrepareRefinements` both do `selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type]`,
  // and that `channels` override is exposed on the CLI (`--channels`) and the API, so formatting a
  // non-"x"-typed variant with a `channels: ["x"]` override produces exactly this. Which rendering
  // this Map hands back is then a convention, not evidence — see the ambiguity guard below, which is
  // why picking the wrong one here is never allowed to reach a write.
  const candidateItemIds = new Set(candidates.map((c) => c.itemId));
  const renderingByItemId = new Map<string, ChannelRendering>();
  for (const r of renderings) {
    if (candidateItemIds.has(r.itemId) && !renderingByItemId.has(r.itemId)) {
      renderingByItemId.set(r.itemId, r);
    }
  }

  // How many eligible (approved, channel "x", non-empty) renderings share an itemId. Almost always
  // 1. When it is more than 1, `renderingByItemId`'s first-wins pick is a convention, not evidence
  // — `bestMatch` only proves the itemId, never which of the sharing renderings' `type`s is right —
  // so a confirmed verdict for that itemId must not reach a write; see the guard below.
  const itemIdOccurrences = new Map<string, number>();
  for (const c of candidates) {
    itemIdOccurrences.set(c.itemId, (itemIdOccurrences.get(c.itemId) ?? 0) + 1);
  }

  const plan: ReconcilePlan = { confirmed: [], candidates: [], external: [], skipped: [] };
  const claimedItemIds = new Set<string>();

  for (const thread of threads) {
    const verdict = classify(thread, candidates);

    if (verdict.kind === "confirmed" || verdict.kind === "candidate") {
      const rendering = renderingByItemId.get(verdict.itemId);
      if (rendering === undefined) {
        // classify only ever returns an itemId drawn from `candidates`, and every candidate's
        // itemId is a key of renderingByItemId — reaching here is a bug worth failing on.
        throw new Error(`classify matched itemId ${verdict.itemId}, which is not one of the x renderings given`);
      }

      if (verdict.kind === "candidate") {
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score });
        continue;
      }

      if ((itemIdOccurrences.get(verdict.itemId) ?? 0) > 1) {
        // More than one approved x rendering shares this itemId under a different `type` — reachable
        // today via a --channels/API override, see the comment above `renderingByItemId`. `type` is
        // part of `deliveryKey`, so confirming on the wrong one writes a delivery row under the wrong
        // key: `send:channels` would still see the real (itemId, type, x-post) as unsent and post it
        // again — the exact duplicate this feature exists to prevent — and a `sent` row is never
        // reversed. Refusing and reporting a candidate costs one human confirmation instead.
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score });
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
        // a candidate for a human to judge rather than silently dropped.
        plan.candidates.push({ rootId: thread.rootId, itemId: verdict.itemId, score: verdict.score });
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
