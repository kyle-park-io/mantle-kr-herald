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
