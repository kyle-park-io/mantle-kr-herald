import type { Db } from "../adapters/db/Db";
import { TABLE_NAMES, ALTERED_COLUMNS } from "../adapters/db/schema";

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

/**
 * Standalone, one-shot check: has this database ever had the FULL schema applied? Checks every
 * table `applySchema` creates (`TABLE_NAMES`, from `schema.ts`) against `information_schema.tables`
 * — not just `deliveries`. A single-table probe answers "yes" the moment the oldest table exists,
 * which is wrong the instant a later table is added to `schema.ts` and an already-migrated database
 * never gets it: that database would report "applied" forever, right up until the first read against
 * the new table fails at runtime with no earlier warning. (`auth_attempts`, added after the tables
 * this probe used to check, is exactly that case.)
 *
 * Also checks every `(table, column)` pair `applySchema` adds via `alter table ... add column if not
 * exists` (`ALTERED_COLUMNS`, from `schema.ts`) against `information_schema.columns` — the same
 * argument one level down, for a table that already exists but is missing a column added to it
 * later. A table-only probe cannot see that gap at all: the table read above already reports "every
 * table present" while a `select` against the missing column fails at runtime. Task 4.5 hit exactly
 * this against the real production database (`translations.posted_url`/`posted_at`) — see
 * `ALTERED_COLUMNS`'s own doc comment for the full story. The table check runs first and short-
 * circuits before the column query when it already fails, since a table that does not exist has no
 * columns worth asking `information_schema.columns` about.
 *
 * `previewCount` above reports 0 for a missing table the same way it would for a genuinely empty,
 * migrated one, so the two cannot be told apart from a preview's counts alone. `db-import.ts`'s and
 * `db-export.ts`'s entry scripts call this once, before printing the preview, to print an explicit
 * "schema not applied yet" line when that is why every count reads 0. `doctor`'s `databaseProbe`
 * (`src/doctor/checks.ts`) calls this too, layered on top of its own real-table select, so `doctor`
 * cannot report "ok" against a database this function would call unapplied.
 */
export async function isSchemaApplied(db: Db): Promise<boolean> {
  const tableRows = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const existingTables = new Set(tableRows.map((r) => r.table_name));
  if (!TABLE_NAMES.every((name) => existingTables.has(name))) return false;

  const columnRows = await db.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public'",
  );
  const existingColumns = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
  return ALTERED_COLUMNS.every(({ table, column }) => existingColumns.has(`${table}.${column}`));
}
