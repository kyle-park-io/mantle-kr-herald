/**
 * The validation rule behind every `HERALD_*` positive-integer environment override: blank or
 * whitespace-only means "unset" (the caller's default applies), and anything else must be a bare,
 * positive, base-10 integer — refused at read time, naming the variable and the exact value that
 * was rejected, rather than silently coerced by `Number()` into something nobody chose.
 *
 * First written for `HERALD_WATCH_BATCH` (`src/cli/watchBatch.ts`); shared here once
 * `HERALD_COLLECT_MAX_PAGES` (`src/adapters/twitterapi/TwitterApiSourceGateway.ts`) needed the
 * exact same rule rather than a second, slightly-different reimplementation of it.
 */
export function parsePositiveIntEnv(raw: string | undefined, envVar: string, fallback: number, example: number): number {
  // An `X=` line with nothing after it reaches Node as "", not as undefined. Treated as unset:
  // `Number("")` is 0, which would otherwise pass through as a real (and almost always wrong)
  // value while the unit/shell that set it looks configured.
  const value = raw?.trim();
  if (!value) return fallback;

  // A digit-only pattern, then a positivity check, rather than `Number.isFinite` +
  // `Number.isInteger`: `Number("0x10")` is 16 and `Number("1e2")` is 100, and both would let a
  // typo silently become a value nobody chose. `/^\d+$/` also refuses fractions and signs
  // (`2.5`, `-3`, `+3`) in the same rule, leaving "0" as the only digit-only string still left
  // for the positivity check to catch.
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(
      `${envVar} must be a positive integer: ${JSON.stringify(raw)}. ` +
        `Use a whole number greater than zero, such as ${example}.`,
    );
  }

  return Number(value);
}
