import { parsePositiveIntEnv } from "../shared/env/positiveInt";
import { DEFAULT_MAX_PAGES } from "../adapters/twitterapi/TwitterApiSourceGateway";

/** The name this dial has in the environment, in one place — the refusal in `watch.ts` names it too. */
export const COLLECT_MAX_PAGES_ENV = "HERALD_COLLECT_MAX_PAGES";

/**
 * Reads and validates the collector's page cap (`HERALD_COLLECT_MAX_PAGES`), defaulting to
 * `DEFAULT_MAX_PAGES` (50) when unset.
 *
 * Why this is a CLI-layer function and not something the gateway reads for itself: the variable
 * exists for one procedure — a hand-run backfill after a coverage GAP alert, where the 50-page cap
 * is the very thing that caused the hole (`docs/ko/team-runbook.md` §4). A constructor reading
 * `process.env` handed that override to every command that builds a `TwitterApiSourceGateway`,
 * including four (`tm:measure`, `metrics:record`, `impressions:record`, `reconcile`) that have
 * nothing to do with the remedy. Only the two commands that actually collect authored history
 * through `CollectAuthoredContent` — and can therefore truncate into permanent loss — call this.
 *
 * The validation rule (blank → default, otherwise a bare positive safe integer or a named throw)
 * is `parsePositiveIntEnv`, shared with `HERALD_WATCH_BATCH` (`src/cli/watchBatch.ts`), which is
 * also the shape this function mirrors: a pure function beside the script, because a top-level
 * script has no test coverage of its own.
 */
export function parseCollectMaxPages(raw: string | undefined): number {
  return parsePositiveIntEnv(raw, COLLECT_MAX_PAGES_ENV, DEFAULT_MAX_PAGES);
}
