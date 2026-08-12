// The translate floor's *rule*, not the floor itself. `src/status/translateFloor.ts` — same basename,
// deliberately, because it is the same concept — is about finding out what the floor is, from systemd
// or from the scheduler's report in Postgres. This module is what is done with the value once known,
// and it is domain code: no I/O and no Node built-ins, so the read-only Vercel function on the
// 링크 수집 path imports it exactly as the CLI does.
import { isSweptAccount } from "../sweptAccount";

/**
 * The two fields the rule reads, and the only two — deliberately narrower than `ContentItem`.
 *
 * `ContentItem` satisfies this structurally, so the two callers that hold whole items
 * (`PrepareTranslations.applySelector`, `createDeps.loadIntakePending`) pass theirs unchanged. The
 * third — `collectedScope` in `src/status/translateFloor.ts`, which counts how much of the collected
 * total the scheduler can reach — is why the parameter is not `ContentItem` itself: it takes an
 * *array*, and requiring an `id`, a `source` and a `text` it never reads would make every fixture in
 * its suite fabricate three fields to ask one question. The fourth, `CollectLinkedThread`'s door
 * gate, holds no item at all — only the root `SourceTweet` an item has yet to be built from — and
 * hands over the two fields `flattenXThreads` would take from that same tweet.
 *
 * Declaring what is read also states the rule's own reach: nothing else about an item can change the
 * answer, so no caller has to wonder which of its fields matter.
 */
export interface TranslateFloorSubject {
  /** ISO, and `""` for a thread `flattenXThreads` found no tweets for — see `meetsTranslateFloor`. */
  createdAt: string;
  /** The X handle that wrote it. Absent for Lark and for a thread stored with no tweets. */
  author?: string;
}

/**
 * Whether the translate floor — `HERALD_TRANSLATE_SINCE` — leaves this item alone.
 *
 * The floor exists to stop the *swept timeline's* whole history pouring into translation oldest
 * first. A post someone pasted into 링크 수집 is not that risk: nothing puts another account's thread
 * in `x_threads` on its own (`src/domain/sweptAccount.ts` states why, and names the hand-run that
 * is the one other way one gets there), so the handle is the marker, and an item authored anywhere
 * but the swept account is one a person chose, which proceeds whatever its date. The swept account's
 * own posts still meet the floor, because a pre-floor one of those is indistinguishable from swept
 * backlog — `CollectLinkedThread` refuses that at the door instead, so it cannot be collected and
 * then silently dropped here.
 *
 * **An unreadable author keeps the floor.** A Lark item has no handle, and neither does an X thread
 * stored with no tweets; reading "unknown" as "not the swept account" would open the entire
 * historical backlog on the next tick. Shut, the worst case is the behaviour that shipped before
 * this rule existed.
 */
function bypassesFloor(item: TranslateFloorSubject): boolean {
  return item.author !== undefined && item.author !== "" && !isSweptAccount(item.author);
}

/**
 * Whether the translate floor lets `translate:prepare` select this item at all, given the floor the
 * tick runs with.
 *
 * **One function because four call sites have to agree.** `PrepareTranslations.applySelector` is
 * the tick that selects; `createDeps.loadIntakePending` is the 링크 수집 waiting list that claims to
 * show what the tick will select; `collectedScope` (`src/status/translateFloor.ts`) is the count of
 * how much of the collected total the tick can reach, which `pnpm status`'s Collected line and the
 * dashboard's 수집 hover card are both formatted from; `CollectLinkedThread.refuseIfBelowFloor` is
 * the door that turns away a link no tick would take rather than storing one. A copy of the rule in
 * each would drift, and a drift here is invisible — the list would simply go on showing an item that
 * never gets translated, the count would report an item as permanently unreachable when a tick is
 * going to take it, and the door would accept a link that then sits nowhere, all with no error
 * anywhere. That is the failure the whole feature exists to remove, and the third and fourth callers
 * were each added because they had exactly that defect. Sharing the function is what makes "the rule
 * is the same in all four" a fact about the code rather than a claim in a comment. (It says nothing
 * about them being handed the same *floor* — `createDeps.loadIntakePending` covers that, and the one
 * window where they are not.)
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
 * rather than parsed to `Date`. Anything cleverer — parsing to `Date`, tolerating a missing timestamp
 * — would let through an item the tick does not take: `createdAt: ""` (a thread `flattenXThreads`
 * found no tweets for) sorts below every floor as a string, so it is never selected, which is the
 * same conservative direction an unreadable author gets above.
 */
export function meetsTranslateFloor(item: TranslateFloorSubject, floor: string | undefined): boolean {
  if (floor === undefined) return true;
  return item.createdAt >= floor || bypassesFloor(item);
}
