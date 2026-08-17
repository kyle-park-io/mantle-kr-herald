import { argValue, parseList } from "./args";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { ConversionSelector } from "../app/PrepareConversions";

/** The flag `src/app/ConvertTick.ts` passes and this module reads — spelled once, for both. */
export const MAX_VARIANTS_FLAG = "--max-variants";

/**
 * `pnpm convert:prepare`'s command line as a `ConversionSelector`.
 *
 * Lifted out of `src/cli/convert-prepare.ts` rather than left at its top level, because that file
 * opens a database connection on import: nothing inline in it can be exercised by a test, and one of
 * these flags is now half of a contract with another process. If this side stopped reading
 * `--max-variants`, the tick would go on passing it, `PrepareConversions` would go on fanning out
 * every pair, and the ten-minute cap would go on being hit — with every test on both sides green.
 * See `tests/cli/convertPrepareSelector.test.ts`.
 *
 * Only keys the command line actually carried are set, never `undefined` ones: `PrepareConversions`
 * distinguishes an absent `maxVariants` (no ceiling — a hand run, or the dashboard's [변환 준비]
 * button) from a present one, and `{ maxVariants: undefined }` would be a third shape for both
 * callers to reason about.
 */
export function conversionSelectorFrom(argv: string[]): ConversionSelector {
  const selector: ConversionSelector = {};

  const ids = parseList(argValue("--ids", argv));
  if (ids) selector.ids = ids;

  const since = argValue("--since", argv);
  if (since) selector.since = since;

  // `Number.isFinite` and nothing stricter, for both numeric flags. Characterisation, not a fresh
  // decision: `--limit` has always ignored a value it could not read rather than refusing to run,
  // and giving the two flags different tempers would be a worse surprise than the one that is here.
  const limit = argValue("--limit", argv);
  if (limit) {
    const n = Number(limit);
    if (Number.isFinite(n)) selector.limit = n;
  }

  const maxVariants = argValue(MAX_VARIANTS_FLAG, argv);
  if (maxVariants) {
    const n = Number(maxVariants);
    if (Number.isFinite(n)) selector.maxVariants = n;
  }

  const typesArg = parseList(argValue("--types", argv));
  if (typesArg) {
    const invalid = typesArg.filter((t) => !ALL_TYPES.includes(t as ConversionType));
    if (invalid.length > 0) throw new Error(`Invalid --types: ${invalid.join(", ")} (allowed: ${ALL_TYPES.join(", ")})`);
    selector.types = typesArg as ConversionType[];
  }

  return selector;
}
