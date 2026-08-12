/**
 * The X account the scheduled sweep reads, and the one question anything needs to ask about it.
 *
 * `pnpm collect` with no argument reads this account's timeline (`src/cli/collect.ts`), and
 * `WatchTick` runs it exactly that way (`WatchTick.ts:181` — no target argument), so this is the
 * only account that accumulates in `x_threads` on its own. The Korean account `@0xMantleKR` is
 * collected too but into a *separate* store (`collect-reference.ts` writes `paths.referenceDir`),
 * as a reference corpus rather than translation input, so it never lands here.
 *
 * That is what makes the handle usable as a marker, and the qualifier is load-bearing: **only one
 * account accumulates automatically**, so a row in `x_threads` authored by anyone else is one a
 * person put there. The spec says it with that qualifier too — "`x_threads`에 **자동으로** 쌓이는
 * 계정은 하나뿐". `meetsTranslateFloor` (`src/domain/translation/translateFloor.ts`) uses exactly
 * that to decide who the translate floor (`HERALD_TRANSLATE_SINCE`) applies to, for the translate
 * tick, the 링크 수집 waiting list and the Collected count alike — see the spec's
 * "번역 기준 시각(`HERALD_TRANSLATE_SINCE`)과의 관계".
 *
 * 링크 수집 is not the only way a person can do it. `pnpm collect <handle>` still takes a target
 * (`src/cli/collect.ts` reads `process.argv[2]`), and `CollectAuthoredContent` writes these same
 * rows — so a hand-run against another account puts that account's whole swept window in
 * `x_threads`, and every row of it then bypasses the floor, which is a larger thing to wave through
 * than the one pasted link the rule was written for. Nothing scheduled does it, so the marker holds
 * for everything that arrives on its own; someone reaching for that command on a floor-gated
 * deployment is choosing that, and this is where they can find out. Narrowing that argument is not
 * this work's to do — the spec's 안 하는 것 keeps `pnpm collect`'s target out of it.
 *
 * Named once rather than spelled in both places: the CLI default and the floor rule have to mean
 * the same account, and two literals drift without anything failing — the floor would simply start
 * applying to the swept account under one spelling and to nobody under the other.
 */
export const SWEPT_ACCOUNT = "Mantle_Official";

/**
 * Whether `handle` names the account above. Case-insensitive, because an X handle is not
 * case-sensitive — `xReconcile.ts`'s `SettledTranslationContext.handle` already follows that
 * convention, and a `@mantle_official` link must not read as a different account here either.
 *
 * An absent or empty handle answers `false`: this predicate reports what is *known*, and a caller
 * that must default conservatively when nothing is known says so at its own call site rather than
 * having that judgement hidden in here.
 */
export function isSweptAccount(handle: string | undefined): boolean {
  return handle !== undefined && handle.toLowerCase() === SWEPT_ACCOUNT.toLowerCase();
}
