import type { FormatWarning } from "../app/FormatVariants";

/**
 * Everything `pnpm format` and `src/app/ConvertTick.ts` have to agree on in text: the one flag the
 * tick passes, and the lines the CLI prints back.
 *
 * The sibling of `./convertPrepareLines.ts`, for the same reason and with the same consequence.
 * The tick spawns `pnpm format` as a subprocess and **fails on any stdout it does not recognise**
 * (a scheduler that reads "unrecognised" as "nothing to do" is green forever while the board never
 * fills), so a rewording on one side is a silent contract break with the other. Both the CLI and
 * `tests/app/convertTick.test.ts` build these from here — never hand-write a fixture for a line
 * another module parses.
 *
 * The parser stays a regex over stdout rather than an equality check against these strings: every
 * stage is spawned as `pnpm <script>`, and pnpm writes its own lines around a script's output.
 */

/**
 * The flag that makes a format run non-destructive, spelled once.
 *
 * It is in this module rather than in the tick because it is the same kind of cross-process
 * agreement as the lines below — `ConvertTick` passes it and `src/cli/format.ts` reads it out of
 * `process.argv` — and because the consequence of the two sides disagreeing is not a crash. A
 * misspelt flag is silently ignored by the CLI, `pnpm format` then runs in its default overwrite
 * mode across the whole database, and every rendering a reviewer edited or approved in 2차 검수 is
 * rebuilt as an unapproved card. Twice an hour, with a green tick each time.
 */
export const ONLY_MISSING_FLAG = "--only-missing";

/** The shape printed when renderings were actually written. `count` is always > 0: see below. */
export function formattedRenderingsLine(count: number): string {
  return `formatted ${count} rendering(s) → the database (renderings)`;
}

/**
 * The shape printed when the run wrote nothing, and the reason it drops the `→ <target>` half: it
 * named a destination nothing was written to.
 *
 * Worded for both modes, because both reach it. Under `--only-missing` — the scheduled tick, whose
 * most common outcome by far this is — it means every converted variant already has its rendering.
 * For a hand run it means the `--ids`/`--types`/`--channels` selection matched no variant at all,
 * which is worth saying out loud rather than reporting as a successful format of nothing.
 */
export const NOTHING_TO_FORMAT_LINE = "formatted 0 rendering(s) — nothing is waiting to be formatted";

/**
 * How many selected items were left alone because they had already gone out — `FormatVariants`'
 * `posted` gate, which applies to every caller including this CLI (see that class's own comment for
 * why, and for what the other choice would have cost).
 *
 * Printed at all because without it this command answers a `pnpm format --ids <a posted item>` with
 * `formatted 0 rendering(s) — nothing is waiting to be formatted`, which reads as "your selector
 * matched no variant" and sends the operator looking for a selector bug. Only when the count is
 * above zero, and never one line per item: under `--only-missing` this is the permanent steady
 * state of every retired item in the database, and the scheduler prints this into a run log on
 * every fire.
 *
 * Deliberately NOT prefixed with `WARNING_PREFIX`, and it is not a `⚠` in any other spelling
 * either. `src/app/ConvertTick.ts` collects lines by that prefix into `TickReport.notes`, which
 * `tickOutcome` prints ahead of the tick's outcome line — and "an item that is finished is still
 * finished" is not something anyone can act on. The summary line above is still the first line the
 * tick parses, so adding this one does not touch that contract.
 */
export function skippedPostedLine(count: number): string {
  return `  skipped ${count} item(s) already posted — 되돌리기 first if one of them really needs re-rendering`;
}

/**
 * How a `FormatWarning` is printed under the summary line, and the prefix a reader (human or tick)
 * finds it by. Indented, because these belong to the line above them.
 */
export const WARNING_PREFIX = "  ⚠ ";

export function formatWarningLine(w: FormatWarning): string {
  return `${WARNING_PREFIX}${w.itemId}/${w.type}/${w.channel}: ${w.messages.join("; ")}`;
}
