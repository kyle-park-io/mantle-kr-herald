/**
 * The first line `pnpm convert:prepare` prints, in the two shapes it has — and the one place their
 * wording is decided.
 *
 * Why this is a module and not two template literals at the `console.log` call sites: `src/app/
 * ConvertTick.ts` parses this line on every scheduled fire and **fails the tick on anything it does
 * not recognise** (a scheduler that reads "unrecognised" as "nothing to do" is green forever while
 * doing nothing). The CLI and the tick are separate processes that agree on nothing but this text,
 * so a rewording on one side is a silent contract break with the other. Both this module's callers
 * and `tests/app/convertTick.test.ts` build the line from here, which is the same rule that test's
 * `statusStdout` follows for `pnpm status`: never hand-write a fixture for a line another module
 * parses.
 *
 * The parser itself deliberately stays a regex over stdout rather than an equality check against
 * these strings — pnpm writes its own lines around a script's output, and the tick has to find this
 * one among them.
 */

/** The shape printed when a batch was actually prepared. `count` is always > 0: see below. */
export function preparedVariantsLine(count: number, worksheetPath: string): string {
  return `prepared ${count} variant(s) → ${worksheetPath}`;
}

/**
 * The shape printed when nothing approved is waiting to be converted — and the reason it has no
 * `→ <path>` half: `convert:prepare` writes no worksheet at all for an empty batch. It used to write
 * one unconditionally, which was harmless at the rate a human runs the command and is not harmless
 * at 48 scheduled fires a day, every day, into a directory nothing prunes.
 */
export const NOTHING_TO_CONVERT_LINE = "prepared 0 variant(s) — nothing approved is waiting to be converted";
