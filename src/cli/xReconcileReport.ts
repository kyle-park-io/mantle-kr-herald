import { tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import type { DbConfig } from "../config";
import { isXCandidateRendering, type CandidateReason } from "../app/ReconcileXPublished";
import type { ChannelRendering } from "../domain/formatting/models";
import { opsNotice } from "../shared/opsAlertGrammar";

/**
 * The lines `x-reconcile.ts` decides rather than merely prints, pulled out of the script for the
 * same reason `watchStartup.ts`'s `watchStartupLine` and `watchSummary.ts`'s `watchOutcome` were: a
 * top-level script has no test coverage of its own, so its load-bearing wording has to live
 * somewhere testable. Everything here is pure — no clock, no I/O, no `process.env`.
 */

/**
 * The one line `x:reconcile` prints before it reads anything, naming which account, which floor,
 * whether this run writes, and **which database it writes to**.
 *
 * The database half is the point. `herald-x-reconcile.service`'s `ExecStart=` carries `--yes`, so
 * unlike every other unit there is no "start it by hand once and read the first line before you
 * `enable`" step available — starting the service by hand *is* the first production write, and
 * `Persistent=true` can fire it at `enable --now` on its own. The runbook's install step therefore
 * has the operator run a preview with the production environment sourced and stop if this line says
 * `development`; without the line there was nothing for that step to read.
 *
 * `tryDescribeDbTarget`, not `describeDbTarget`, for the same reason `watchStartupLine` uses it: a
 * malformed DSN in `~/.herald/prod.env` would otherwise throw a `URL` constructor's message, which
 * is not guaranteed to have dropped the `user:password@` it was handed — and that message goes to
 * the journal and from there into a Telegram alert via the `OnFailure=` hook's journal excerpt.
 * Host and database name only, never the password.
 */
export function xReconcileStartupLine(input: {
  handle: string;
  since: string;
  write: boolean;
  db: DbConfig;
}): string {
  const { handle, since, write, db } = input;
  return (
    `x:reconcile — @${handle}, since ${since} · database ${db.env} · ` +
    `${tryDescribeDbTarget(db) ?? INVALID_DB_URL}${write ? "" : " (preview — no --yes)"}`
  );
}

/**
 * The `external` section's headline, including what a `score === 0` row actually means.
 *
 * It used to say "no approved copy existed to compare against, or the text was too short to score at
 * all". Both of those do produce 0 — `classify` returns `{ score: 0 }` with no candidates, and
 * `similarity` floors at 0 for either side under 3 normalized characters — but they are not the only
 * ways. Two strings of 3+ normalized characters that share no 3-gram score exactly 0.0 by
 * construction (`intersectionSize / unionSize` with an empty intersection), so a thread compared
 * against real approved copy that simply does not overlap it lands here too. That is the *ordinary*
 * case for this account: the pipeline had produced three `x` renderings against 47 live posts, and
 * an unrelated Korean post shares no 3-gram with an unrelated Korean rendering more often than not.
 * The old wording told the operator reading the headline summary that no approved copy existed, when
 * some did and simply did not match.
 */
export function externalSummaryLine(external: { score: number }[]): string {
  const zeroScored = external.filter((e) => e.score === 0).length;
  const zeroNote =
    zeroScored > 0
      ? `; ${zeroScored} scored 0 (nothing in common with any approved copy — either none existed to ` +
        `compare against, or none of it shared a single 3-gram with the post)`
      : "";
  return `external (${external.length}) — live, but not our approved copy${zeroNote}.`;
}

/** Eligible renderings' `type`s sharing `itemId`, through the same `isXCandidateRendering` predicate
 *  `reconcileXPublished` itself used — never a re-spelling of it (see that function's own doc comment
 *  for what a second spelling cost). Read back here because a candidate carries no `type` of its own
 *  (see `ReconcilePlan`'s doc comment): a report that names "ambiguous" has to show what it is
 *  ambiguous *between*, or the word is just decoration. */
export function xTypesFor(itemId: string, renderings: ChannelRendering[]): string[] {
  return renderings.filter((r) => r.itemId === itemId && isXCandidateRendering(r)).map((r) => r.type);
}

/**
 * One line per candidate reason, written for the human deciding what to do next rather than for
 * whoever already read `ReconcileXPublished.ts`'s `CandidateReason` doc comment — this is what
 * shows up in `journalctl` when nobody has the source open. Each reason means a different next
 * action, and a candidate that only echoed its slug would force that reconstruction every time.
 */
export function candidateReasonText(reason: CandidateReason, itemId: string, renderings: ChannelRendering[]): string {
  switch (reason) {
    case "possible-match":
      return "reads like our copy but wasn't an exact paste (maybe edited after posting) — confirm it by hand if it is the same post";
    case "duplicate-live-thread":
      return `another live thread already claimed ${itemId} in this run and took the confirmation — decide which post is the real one`;
    case "ambiguous-rendering-type": {
      const types = xTypesFor(itemId, renderings);
      return `${itemId} has ${types.length || "several"} eligible x renderings (types: ${types.join(", ") || "?"}) — confirming risked the wrong deliveryKey, so this was refused rather than guessed`;
    }
  }
}

/**
 * `plan.postedNearMisses`, highest score first, for the `posted` section's near-miss block — the
 * counterpart to the `external` block's own `nearMisses` sort in `x-reconcile.ts`.
 *
 * The near-misses themselves are no longer computed here. They used to be
 * (`translationNearMisses`, removed in Task 4 review round 2): this file's own re-derivation of
 * "which threads were still available" went stale again the moment a settled-but-genuinely-done
 * translation started claiming its thread without ever appearing in `plan.posted` (Concern 2) — a
 * caller reconstructing the excluded set from `plan.posted` alone could no longer see that claim.
 * `reconcileXPublished` now computes `postedNearMisses` itself, against the exact pool it used at
 * the moment of scoring (see `ReconcilePlan`'s own doc comment), so there is exactly one place this
 * list is built. This function is display-only: sorting, not deciding.
 */
export function sortedPostedNearMisses<T extends { score: number }>(nearMisses: T[]): T[] {
  return [...nearMisses].sort((a, b) => b.score - a.score);
}

/**
 * Minimum retire count within a single `x:reconcile --yes` run before `notifyOps` fires — below
 * this, retiring a translation is this feature doing its job silently; at or above it, a human
 * should know without reading the run's journal.
 */
export const NOTIFY_RETIRE_THRESHOLD = 3;

/**
 * Whether this run should page an operator about its retires, and the message to send if so — the
 * ">= 3" decision `x-reconcile.ts` used to make inline (Task 4 review's Finding 6: a load-bearing
 * constant with no test that can fail, in a file whose whole reason for existing is that a
 * top-level script has no test coverage of its own). Returns `undefined` below the threshold, so
 * the caller's own `if` reads as "is there something to send" rather than repeating the comparison.
 */
export function retireNotification(retiredCount: number, retiredItemIds: string[], handle: string): string | undefined {
  if (retiredCount < NOTIFY_RETIRE_THRESHOLD) return undefined;
  // The IDs were a comma-run in one paragraph — 14 of them in a real 2026-08-07 alert, unreadable
  // on a phone. One per line inside the shared <pre> block instead.
  return opsNotice({
    icon: "ℹ",
    title: `x:reconcile — 손으로 이미 올라가 있던 번역 ${retiredCount}건 은퇴 (@${handle})`,
    lines: retiredItemIds,
  });
}
