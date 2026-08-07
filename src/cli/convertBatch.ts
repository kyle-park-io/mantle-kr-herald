import { parsePositiveIntEnv } from "../shared/env/positiveInt";

/**
 * How many approved items one conversion tick prepares when `HERALD_CONVERT_BATCH` is unset.
 *
 * One, not three (the watch scheduler's figure), because the two batches count different things.
 * `translate:prepare --limit 3` produces three items in one worksheet; `convert:prepare --limit 1`
 * fans that one item out to every type it has not been converted for — up to six (`ALL_TYPES`) — and
 * all of them are written by the *same single* `claude -p` call, under `ClaudeCodeAgent`'s 10-minute
 * cap. Six pieces of copy in one call is already the busy end of that budget; eighteen is not a
 * batch size, it is a timeout.
 *
 * Throughput is not what constrains this anyway. At the timer's 30-minute cadence one item per tick
 * is 48 items a day, against a watch scheduler whose own ceiling is 3 items every two hours — 36 a
 * day — of which only the ones a human approves in 1차 검수 ever reach this queue at all. The
 * conversion side is designed to be comfortably faster than the side feeding it, so that the board is
 * populated by the time a reviewer arrives rather than a tick behind.
 */
export const DEFAULT_CONVERT_BATCH = 1;

/**
 * Reads and validates the conversion scheduler's batch size (`HERALD_CONVERT_BATCH`).
 *
 * A separate variable from `HERALD_WATCH_BATCH` rather than a shared one: they are dials on two
 * different units with two different cadences, and — per the constant above — they do not even
 * measure the same thing, so one value tuned for the translate side would silently misconfigure this
 * one. `parseWatchBatch` in this directory is the pattern this follows; the validation rule itself
 * (blank → default, otherwise a bare positive integer or a named throw) lives in
 * `parsePositiveIntEnv`, shared with both of the other `HERALD_*` integer overrides.
 */
export function parseConvertBatch(raw: string | undefined): number {
  return parsePositiveIntEnv(raw, "HERALD_CONVERT_BATCH", DEFAULT_CONVERT_BATCH);
}
