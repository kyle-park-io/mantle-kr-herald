/**
 * The eleven stores `db:import`/`db:export` move between `output/` (plus the `translation/` and
 * `conversion/` config trees) and Postgres — see `docs/superpowers/specs/2026-07-31-hosted-writes-
 * design.md`'s "What moves" table, whose own membership test ("does the hosted dashboard read or
 * write it?") is authoritative over any narrower guess either command's implementation makes.
 *
 * `StoreCounts` is shared by `db-import.ts` (`ImportReport = StoreCounts`) and `db-export.ts`
 * (`ExportReport = StoreCounts`) rather than each declaring its own interface. That is not a
 * cosmetic dedup: it is what makes "whatever import carries, export must return" a property the
 * type checker enforces instead of a promise the two files could quietly drift apart on — add a
 * field here and both `importOutputTree` and `exportOutputTree` fail to typecheck until they
 * populate it.
 */
export interface StoreCounts {
  xThreads: number;
  larkItems: number;
  translations: number;
  variants: number;
  renderings: number;
  outletOverrides: number;
  deliveries: number;
  xArticleDeliveries: number;
  publishEntries: number;
  lineageEntries: number;
  fewShotExamples: number;
}

export type StoreKey = keyof StoreCounts;

/**
 * Printed in the same order the design spec's table lists them: collect (x, lark) → translate →
 * convert → format → send → lineage (cross-cutting) → few-shot (promoted out of translate/convert,
 * listed last in the spec's own table too). One label per key, so the print order and the report
 * shape can never fall out of sync with each other.
 */
export const STORE_ORDER: ReadonlyArray<{ key: StoreKey; label: string }> = [
  { key: "xThreads", label: "x threads" },
  { key: "larkItems", label: "lark items" },
  { key: "translations", label: "translations" },
  { key: "variants", label: "variants" },
  { key: "renderings", label: "renderings" },
  { key: "outletOverrides", label: "outlet overrides" },
  { key: "deliveries", label: "deliveries" },
  { key: "xArticleDeliveries", label: "x-article deliveries" },
  { key: "publishEntries", label: "publish entries" },
  { key: "lineageEntries", label: "lineage entries" },
  { key: "fewShotExamples", label: "few-shot examples" },
];

/** Every label padded to the same column, computed from the labels themselves so the two files
 *  above (and this one) cannot drift into inconsistent alignment the way the previous version's
 *  two independently hand-padded `describeReport` copies did. */
const LABEL_WIDTH = Math.max(...STORE_ORDER.map(({ label }) => label.length)) + 2;

/** `"  x threads               12"` — one line per store, in `STORE_ORDER`. */
export function describeCounts(counts: StoreCounts): string[] {
  return STORE_ORDER.map(({ key, label }) => `  ${label.padEnd(LABEL_WIDTH)}${counts[key]}`);
}

export interface PreviewCounts {
  current: number;
  incoming: number;
}

/** `"  x threads               current 0 -> incoming 12"` — the diff a flagless `db:import` run
 *  shows before anything is written, modeled on `state:pull`'s preview (`stateFiles.ts`'s
 *  `describeStateDiff`): an operator reads what is about to change before confirming it. */
export function describePreview(preview: Record<StoreKey, PreviewCounts>): string[] {
  return STORE_ORDER.map(({ key, label }) => {
    const { current, incoming } = preview[key];
    return `  ${label.padEnd(LABEL_WIDTH)}current ${current} -> incoming ${incoming}`;
  });
}

/**
 * Postgres's message for a table that was never created via `create table` — the same shape
 * `doctor/checks.ts`'s `describeSchemaProbeError` matches, for the same underlying reason: a
 * database `applySchema` has never run against raises exactly this on its first read.
 */
function isSchemaMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(message);
}

/**
 * Wraps a single store's database read for a preview. `previewImport`/`previewExport` must never
 * apply the schema themselves — a preview is reachable flagless against production and against a
 * mistyped `DATABASE_URL`, where creating eleven tables as a side effect of merely *looking* would
 * be its own hazard, and a read-only database role must be able to run one at all. So a table that
 * does not exist yet is not a bug here: it is reported as 0, the same number a genuinely empty,
 * migrated table would give, rather than thrown. Any other failure (bad credentials, network) is
 * rethrown unchanged — this only ever swallows the one specific, expected shape of "not migrated
 * yet".
 */
export async function previewCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (isSchemaMissingError(err)) return 0;
    throw err;
  }
}

// `isSchemaApplied` used to live here. Task 4.5 review moved it into `src/adapters/db/schema.ts`,
// beside `TABLE_NAMES` and `ALTERED_COLUMNS` — its two inputs — because `src/doctor/checks.ts`
// needed it too, and every other cross-reference between `src/cli` and `src/doctor` goes from `cli`
// importing out of `doctor/checks.ts`, never the other way around: a `doctor` file importing out of
// `cli/dbStores.ts` would have been the one import in this codebase pointed backwards. Its callers
// (`db-import.ts`, `db-export.ts`, `doctor/checks.ts`) now import it straight from `schema.ts`
// instead — not re-exported from here — so there is exactly one place it is defined and exactly one
// place each caller reaches for it, rather than an indirection through this file that adds nothing.
