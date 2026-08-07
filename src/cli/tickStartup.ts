import { outputRootResult } from "../doctor/checks";
import { tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import type { DbConfig } from "../config";

/**
 * The one line a scheduled tick's entry point prints before any stage runs, naming which output root
 * and which database that tick is attached to, plus whatever inputs it was configured with.
 *
 * This is the enforcement the watch scheduler's design asks for
 * (docs/superpowers/specs/2026-08-05-watch-scheduler-design.md: "any command running against a
 * non-default root [must] say so on startup") — before it existed, `pnpm doctor` was the only command
 * that did. A wrong tree or a wrong database is exactly what cost 39 threads once (see `src/paths.ts`'s
 * `OUTPUT_DIR` doc comment for the incident), and nothing in the journal would have shown it:
 * `journalctl --user -u <unit>` is where an operator actually looks after the fact.
 *
 * Pulled out into a pure function for the same reason `tickOutcome` is: a top-level script has no
 * test coverage of its own, so the one decision that matters — what this line says — has to live
 * somewhere testable.
 *
 * Reuses `outputRootResult`'s own `(default)` / `(HERALD_OUTPUT_DIR override)` wording, so this line
 * and `pnpm doctor`'s never describe the same fact two different ways, and `tryDescribeDbTarget` so
 * the database is named the same way `pnpm status`'s first line already does — host and database
 * name only, never the password embedded in `DATABASE_URL`.
 *
 * `tryDescribeDbTarget`, not `describeDbTarget`: this is the *first* statement an entry point runs,
 * so a malformed DSN in `~/.herald/prod.env` would otherwise throw straight out of it, and
 * `registerErrorHandler` would print the thrown message — which is a `URL` constructor's, and
 * therefore not guaranteed to have dropped the `user:password@` it was handed. That message goes to
 * the journal, and from there into a Telegram alert via the `OnFailure=` hook's journal excerpt.
 * `src/doctor/checks.ts` already refused to take that risk one file over.
 *
 * `extras` are the tick's own inputs — the values an operator can change on the unit without a
 * deploy. They join the line for the same reason the output root and the database do: a journal that
 * records a tick's outcome but not its inputs cannot be read after the fact. Each caller states every
 * one of its inputs, including the absent ones (`translate floor (none)` rather than a dropped
 * field): "no cutoff" and "cutoff configured" are the two most consequential ticks there are, and a
 * line that omits the floor when unset looks identical to one that simply forgot to print it.
 */
export function tickStartupLine(
  label: string,
  outputDir: string,
  outputOverride: string | undefined,
  db: DbConfig,
  extras: string[],
): string {
  const root = outputRootResult(outputDir, outputOverride).detail;
  return [
    `${label}: output root ${root}`,
    `database ${db.env} · ${tryDescribeDbTarget(db) ?? INVALID_DB_URL}`,
    ...extras,
  ].join(" · ");
}
