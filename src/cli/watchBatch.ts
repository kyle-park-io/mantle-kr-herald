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
 * pattern this function follows.
 */
export function parseWatchBatch(raw: string | undefined): number {
  // An `HERALD_WATCH_BATCH=` line with nothing after it reaches Node as "", not as undefined.
  // Treated as unset: `Number("")` is 0, which would otherwise pass through as `--limit 0` — a
  // tick that prepares nothing, forever, while the unit file looks configured.
  const value = raw?.trim();
  if (!value) return DEFAULT_WATCH_BATCH;

  // A digit-only pattern, then a positivity check, rather than `Number.isFinite` +
  // `Number.isInteger`: `Number("0x10")` is 16 and `Number("1e2")` is 100, and both would let a
  // unit-file typo silently become a batch size nobody chose. `/^\d+$/` also refuses fractions
  // and signs (`2.5`, `-3`, `+3`) in the same rule, so "0" is the only digit-only string still
  // left for the second check to catch.
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(
      `HERALD_WATCH_BATCH must be a positive integer: ${JSON.stringify(raw)}. ` +
        `Use a whole number greater than zero, such as 3.`,
    );
  }

  return Number(value);
}
