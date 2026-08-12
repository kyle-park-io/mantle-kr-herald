import { isSweptAccount } from "../sweptAccount";
import type { ContentItem } from "./contentItem";

/**
 * The translate floor's selection rule — the one function that answers "will a tick take this item?".
 *
 * Distinct from `src/status/translateFloor.ts`, which is about *finding out* what the floor is
 * (systemd, or the scheduler's report in Postgres). This module is what is done with it once known,
 * and it is a domain rule: no I/O, no Node built-ins, so the read-only Vercel function on the
 * 링크 수집 path imports it exactly as the CLI does.
 *
 * **It exists because two call sites have to agree.** `PrepareTranslations.applySelector` is the tick
 * that selects, and `createDeps.loadIntakePending` is the 링크 수집 waiting list that claims to show
 * what the tick will select. A copy of the rule in each would let them drift, and a drift here is
 * invisible: the list would simply keep showing an item that never gets translated, with no error
 * anywhere — the failure this whole feature was designed to remove. One function is what makes
 * "they cannot disagree" a fact about the code rather than a claim in a comment.
 */

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
 * Whether `translate:prepare` will select this item, given the floor the tick runs with.
 *
 * The whole question, not half of it — a caller left to combine a bypass predicate with its own date
 * comparison is a caller free to combine it differently, which is exactly the drift the module
 * comment above exists to rule out.
 *
 * `undefined` floor answers `true` for everything. That is not a convenience default: it is the same
 * refusal `CollectLinkedThread`'s door gate makes. No floor *known* is not the same fact as no floor
 * set, and inventing one here would hide real items behind a guess. A tick that genuinely runs with
 * none does select the whole backlog, so `true` is also the honest answer in that case.
 *
 * `>=` — the floor instant itself is inside the window — and the comparison is on the ISO strings,
 * never parsed to `Date`. `src/status/translateFloor.ts`'s `collectedScope` says why: an item with
 * `createdAt: ""` (a thread `flattenXThreads` found no tweets for) sorts below every floor, which is
 * the conservative direction and matches what it is also given for its unreadable author.
 */
export function meetsTranslateFloor(item: ContentItem, floor: string | undefined): boolean {
  if (floor === undefined) return true;
  return item.createdAt >= floor || bypassesFloor(item);
}
