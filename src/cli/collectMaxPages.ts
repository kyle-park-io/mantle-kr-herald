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

/**
 * Throws if `HERALD_COLLECT_MAX_PAGES` is set at all. Called by `src/cli/watch.ts` before the
 * startup line and before any stage, in the same position and for the same reason as
 * `parseWatchBatch`/`parseTranslateSince`.
 *
 * "The scheduler's own unit never sets this" was asserted in three places — `.env.example`, this
 * variable's own header, the CHANGELOG — and checked nowhere. The tick spawns each stage as
 * `pnpm <script>` (`src/adapters/agent/runStage.ts`), so a child inherits both the shell
 * environment and the repo's `.env`: a stray `HERALD_COLLECT_MAX_PAGES=5` left in `.env` after a
 * backfill would truncate every scheduled collect, GAP-fail every tick, and lose the older tail
 * each time — the exact permanent loss the GAP work exists to close, now on a two-hourly schedule.
 * A tick has no legitimate reason to move the page cap: backfill is a hand-run `collect`.
 *
 * A blank value returns quietly rather than refusing. `.env.example` ships the line as
 * `HERALD_COLLECT_MAX_PAGES=` and installs are made by copying that file, so an empty value is the
 * normal unset state, not an override — and `parseCollectMaxPages` already reads it as the default.
 */
export function refuseCollectMaxPagesOverride(raw: string | undefined): void {
  if (!raw?.trim()) return;
  throw new Error(
    `${COLLECT_MAX_PAGES_ENV} is set (${JSON.stringify(raw)}), and a watch tick must never ` +
      `override the collector's page cap: a low value truncates every scheduled collect, fails ` +
      `every tick on the resulting coverage GAP, and loses the older tail each time. Raising the ` +
      `cap belongs to a one-off hand-run backfill after a GAP alert — see docs/ko/team-runbook.md ` +
      `§4 "수집에 구멍이 생겼을 때". Unset it and start the tick again; check the repo's .env as ` +
      `well as the shell, because each stage runs as \`pnpm <script>\` and reads that file too.`,
  );
}
