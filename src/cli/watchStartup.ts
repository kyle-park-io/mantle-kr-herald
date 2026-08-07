import type { DbConfig } from "../config";
import { tickStartupLine } from "./tickStartup";

/**
 * `watch.ts`'s startup line: `tickStartupLine` under this command's own label, plus the two inputs
 * only this tick has.
 *
 * The composition, and the reasoning behind every part of it (why the output root and the database
 * are named at all, why `tryDescribeDbTarget` rather than `describeDbTarget`), moved to
 * `./tickStartup` when `convert:tick` became a second scheduled tick needing the identical line.
 *
 * `tick.batch` and `tick.translateSince` are stated here because they are what `HERALD_WATCH_BATCH`
 * and `HERALD_TRANSLATE_SINCE` let an operator change without a deploy (`src/cli/watchBatch.ts`,
 * `src/cli/translateSince.ts`). An absent translation floor is printed as `(none)` rather than
 * dropped — see `tickStartupLine`'s own note on why.
 */
export function watchStartupLine(
  outputDir: string,
  outputOverride: string | undefined,
  db: DbConfig,
  tick: { batch: number; translateSince?: string },
): string {
  return tickStartupLine("watch", outputDir, outputOverride, db, [
    `batch ${tick.batch}`,
    `translate floor ${tick.translateSince ?? "(none)"}`,
  ]);
}
