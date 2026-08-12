/**
 * The X account the scheduled sweep reads, and the one question anything needs to ask about it.
 *
 * `pnpm collect` with no argument reads this account's timeline (`src/cli/collect.ts`), and
 * `WatchTick` runs it exactly that way (`WatchTick.ts:181` — no target argument), so this is the
 * only account that accumulates in `x_threads` on its own. The Korean account `@0xMantleKR` is
 * collected too but into a *separate* store (`collect-reference.ts` writes `paths.referenceDir`),
 * as a reference corpus rather than translation input, so it never lands here.
 *
 * That is what makes the handle usable as a marker: a row in `x_threads` authored by anyone else
 * can only have arrived through 링크 수집, hand-picked by a person. `PrepareTranslations` uses
 * exactly that to decide who the translate floor (`HERALD_TRANSLATE_SINCE`) applies to — see the
 * spec's "번역 기준 시각(`HERALD_TRANSLATE_SINCE`)과의 관계" and `applySelector`.
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
