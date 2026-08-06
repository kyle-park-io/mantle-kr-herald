import { outputRootResult, tryDescribeDbTarget, INVALID_DB_URL } from "../doctor/checks";
import type { DbConfig } from "../config";

/**
 * The one line `watch.ts` prints before any stage runs, naming which output root and which
 * database this tick is attached to.
 *
 * This is the enforcement the design actually asks for
 * (docs/superpowers/specs/2026-08-05-watch-scheduler-design.md: "any command running against a
 * non-default root [must] say so on startup") — before this, `pnpm doctor` was the only command
 * that did. A wrong tree or a wrong database is exactly what cost 39 threads once (see
 * `src/paths.ts`'s `OUTPUT_DIR` doc comment for the incident), and nothing in the journal would
 * have shown it: `journalctl --user -u herald-watch` is where an operator actually looks after the
 * fact, and until this line existed it said nothing about either.
 *
 * Pulled out of `watch.ts` into its own pure function for the same reason `watchSummary.ts`'s
 * `watchOutcome` is: a top-level script has no test coverage of its own, so the one decision that
 * matters — what this line says — has to live somewhere testable.
 *
 * Reuses `outputRootResult`'s own `(default)` / `(HERALD_OUTPUT_DIR override)` wording, so this
 * line and `pnpm doctor`'s never describe the same fact two different ways, and
 * `tryDescribeDbTarget` so the database is named the same way `pnpm status`'s first line already
 * does — host and database name only, never the password embedded in `DATABASE_URL`.
 *
 * `tryDescribeDbTarget`, not `describeDbTarget`: this is the *first* statement `watch.ts` runs, so
 * a malformed DSN in `~/.herald/prod.env` would otherwise throw straight out of the entry point,
 * and `registerErrorHandler` would print the thrown message — which is a `URL` constructor's, and
 * therefore not guaranteed to have dropped the `user:password@` it was handed. That message goes
 * to the journal, and from there into a Telegram alert via the `OnFailure=` hook's journal
 * excerpt. `src/doctor/checks.ts` already refused to take that risk one file over.
 */
export function watchStartupLine(outputDir: string, outputOverride: string | undefined, db: DbConfig): string {
  const root = outputRootResult(outputDir, outputOverride).detail;
  return `watch: output root ${root} · database ${db.env} · ${tryDescribeDbTarget(db) ?? INVALID_DB_URL}`;
}
