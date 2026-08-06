import { parsePositiveIntEnv } from "../shared/env/positiveInt";

/** The batch size a tick uses when `HERALD_WATCH_BATCH` is unset. */
export const DEFAULT_WATCH_BATCH = 3;

/**
 * Reads and validates the watch scheduler's batch size (`HERALD_WATCH_BATCH`).
 *
 * Why a batch size exists at all: it is the tick's throughput dial. A tick every two hours
 * translating `batch` items processes `batch * 24 / 2` items per day — the number that decides
 * whether the pipeline keeps pace with collection or quietly falls behind it. That ratio gets
 * tuned by watching the backlog grow or shrink, not by reading the code, and it changes on a
 * different clock than this code does: an operator adjusting throughput should not need a deploy
 * to do it.
 *
 * The value is deliberately configuration (a unit's `Environment=`) rather than a constant here,
 * for the same reason `HERALD_TRANSLATE_SINCE` is: `parseTranslateSince` in this directory is the
 * pattern this function follows. The validation rule itself (blank → default, otherwise a bare
 * positive integer or a named throw) lives in `parsePositiveIntEnv` — shared with
 * `HERALD_COLLECT_MAX_PAGES` (`src/cli/collectMaxPages.ts`), which needs the exact same rule.
 */
export function parseWatchBatch(raw: string | undefined): number {
  return parsePositiveIntEnv(raw, "HERALD_WATCH_BATCH", DEFAULT_WATCH_BATCH);
}
