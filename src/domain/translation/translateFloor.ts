// The translate floor's *rule*, not the floor itself. `src/status/translateFloor.ts` — same basename,
// deliberately, because it is the same concept — is about finding out what the floor is, from systemd
// or from the scheduler's report in Postgres. This module is what is done with the value once known,
// and it is domain code: no I/O and no Node built-ins, so the read-only Vercel function on the
// 링크 수집 path imports it exactly as the CLI does.
import { isSweptAccount } from "../sweptAccount";
import type { ContentItem } from "./contentItem";

/**
 * Whether the translate floor — `HERALD_TRANSLATE_SINCE` — leaves this item alone.
 *
 * The floor exists to stop the *swept timeline's* whole history pouring into translation oldest
 * first. A post someone pasted into 링크 수집 is not that risk: nothing but that tab can put another
 * account's thread in `x_threads` (`src/domain/sweptAccount.ts` states why), so the handle is the
 * marker, and an item authored anywhere but the swept account is a hand-picked one that proceeds
 * whatever its date. The swept account's own posts still meet the floor, because a pre-floor one of
 * those is indistinguishable from swept backlog — `CollectLinkedThread` refuses that at the door
 * instead, so it cannot be collected and then silently dropped here.
 *
 * **An unreadable author keeps the floor.** A Lark item has no handle, and neither does an X thread
 * stored with no tweets; reading "unknown" as "not the swept account" would open the entire
 * historical backlog on the next tick. Shut, the worst case is the behaviour that shipped before
 * this rule existed.
 */
function bypassesFloor(item: ContentItem): boolean {
  return item.author !== undefined && item.author !== "" && !isSweptAccount(item.author);
}

/**
 * Whether the translate floor lets `translate:prepare` select this item at all, given the floor the
 * tick runs with.
 *
 * **One function because two call sites have to agree.** `PrepareTranslations.applySelector` is the
 * tick that selects; `createDeps.loadIntakePending` is the 링크 수집 waiting list that claims to show
 * what the tick will select. A copy of the rule in each would drift, and a drift here is invisible —
 * the list would simply go on showing an item that never gets translated, with no error anywhere,
 * which is the failure the whole feature exists to remove. Sharing the function is what makes "the
 * rule is the same in both" a fact about the code rather than a claim in a comment. (It says nothing
 * about the two being handed the same *floor* — `createDeps.loadIntakePending` covers that, and the
 * one window where they are not.)
 *
 * It answers the whole question rather than half of it, for the same reason: a caller left to
 * combine a bypass predicate with its own date comparison is a caller free to combine it
 * differently.
 *
 * **"At all" is the precise claim, and it is why this one predicate is enough.** `applySelector` has
 * two other filters and neither is permanent: `selector.ids` is only ever set by a hand-run, and
 * `selector.limit` — the tick's batch (`DEFAULT_WATCH_BATCH`) — decides *which* tick takes a queued
 * item, never *whether* one does. Items come out of the store in insertion order and new ones are
 * appended, so a queue longer than one batch drains over successive ticks with nothing stranded. The
 * floor is the one filter that drops an item for good, which is why a list that applies it is
 * showing what the pipeline will process.
 *
 * `undefined` floor answers `true` for everything. That is not a convenience default: it is the same
 * refusal `CollectLinkedThread`'s door gate makes. No floor *known* is not the same fact as no floor
 * set, and inventing one here would hide real items behind a guess. A tick that genuinely runs with
 * none does select the whole backlog, so `true` is the honest answer in that case too.
 *
 * `>=`, so the floor instant itself is inside the window, and the comparison is on the ISO strings
 * rather than parsed to `Date` — `collectedScope` in `src/status/translateFloor.ts` says why: an item
 * with `createdAt: ""` (a thread `flattenXThreads` found no tweets for) sorts below every floor, the
 * same conservative direction an unreadable author gets above.
 */
export function meetsTranslateFloor(item: ContentItem, floor: string | undefined): boolean {
  if (floor === undefined) return true;
  return item.createdAt >= floor || bypassesFloor(item);
}
