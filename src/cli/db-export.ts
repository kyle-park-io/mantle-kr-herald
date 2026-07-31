import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { OUTPUT_DIR } from "../paths";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonOutletOverrideStore } from "../adapters/store/JsonOutletOverrideStore";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import { PgTranslationStore } from "../adapters/store/PgTranslationStore";
import { PgConversionStore } from "../adapters/store/PgConversionStore";
import { PgFormattingStore } from "../adapters/store/PgFormattingStore";
import { PgOutletOverrideStore } from "../adapters/store/PgOutletOverrideStore";
import { PgDeliveryLedger } from "../adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../adapters/store/PgXArticleLedger";
import { PgPublishStore } from "../adapters/store/PgPublishStore";
import { PgLineageStore } from "../adapters/store/PgLineageStore";

/** Per-store row counts, in pipeline order — see `describeReport()` below. */
export interface ExportReport {
  translations: number;
  variants: number;
  renderings: number;
  outletOverrides: number;
  deliveries: number;
  xArticleDeliveries: number;
  publishEntries: number;
  lineageEntries: number;
}

/**
 * The rollback path. Reads each `Pg*` store — in `ordinal` order, which is insertion order (see
 * `src/adapters/db/schema.ts`) — and writes through the matching `Json*` store pointed at
 * `outputRoot`, so the file it produces is not a reimplementation of what `Json*Store.upsert`/`add`/
 * `record`/`append` already does; it is that exact code, run once per row.
 *
 * That reuse is what makes the round trip in `tests/cli/dbRoundTrip.test.ts` byte-for-byte: the same
 * `writeJsonFileAtomic` call (2-space `JSON.stringify` plus a trailing newline) that originally wrote
 * `translations.json` writes it again here, over the same in-declaration-order object shape each
 * `Pg*` store's mapper already builds (see e.g. `PgTranslationStore`'s `toTranslation`) with
 * `omitNulls` dropping — not nulling — an absent optional field, and rows visited in `ordinal` order
 * so a `Map`-based upsert like `JsonTranslationStore.upsert`'s never has anything to reorder.
 *
 * Mirrors `importOutputTree`'s scope exactly — the seven `state:push`-tracked files plus
 * `formatted/renderings.json` and `lineage/`; few-shot/glossary corpora and collected content are
 * out of scope there for reasons documented on that function, and are equally out of scope for the
 * reverse direction.
 *
 * Assumes `outputRoot` is not carrying *stale* content of its own — a fresh directory (as every test
 * here uses), or an `output/` tree that has not been written to since cutover (true by construction:
 * Task 17 points every other command at `Pg*` stores, leaving `db:export` "the one place that must
 * still write files"). Each `Json*` store's `upsert`/`add`/`record` merges by natural key against
 * whatever the file already holds, so a row present in a *stale* target file but no longer present in
 * the database (deleted through the app after cutover) would survive the export untouched — the same
 * class of gap `db:import`'s own doc comment calls out for the opposite direction, and, like that
 * one, not something this function defends against.
 */
export async function exportOutputTree(db: Db, outputRoot: string): Promise<ExportReport> {
  const translationsDir = join(outputRoot, "translations");
  const variantsDir = join(outputRoot, "variants");
  const formattedDir = join(outputRoot, "formatted");
  const publishDir = join(outputRoot, "publish");
  const lineageDir = join(outputRoot, "lineage");

  const translations = await new PgTranslationStore(db).loadAll();
  const jsonTranslations = new JsonTranslationStore(translationsDir);
  for (const t of translations) await jsonTranslations.upsert(t);

  const variants = await new PgConversionStore(db).loadAll();
  const jsonVariants = new JsonConversionStore(variantsDir);
  for (const v of variants) await jsonVariants.upsert(v);

  const renderings = await new PgFormattingStore(db).loadAll();
  const jsonRenderings = new JsonFormattingStore(formattedDir);
  for (const r of renderings) await jsonRenderings.upsert(r);

  const outletOverrides = await new PgOutletOverrideStore(db).loadAll();
  const jsonOutletOverrides = new JsonOutletOverrideStore(formattedDir);
  for (const o of outletOverrides) await jsonOutletOverrides.upsert(o);

  const deliveries = await new PgDeliveryLedger(db).loadAll();
  const jsonDeliveries = new JsonDeliveryLedger(publishDir);
  for (const d of deliveries) await jsonDeliveries.add(d);

  const xArticleDeliveries = await new PgXArticleLedger(db).loadAll();
  const jsonXArticleDeliveries = new JsonXArticleLedger(publishDir);
  for (const x of xArticleDeliveries) await jsonXArticleDeliveries.add(x);

  const publishEntries = await new PgPublishStore(db).listEntries();
  const jsonPublishEntries = new JsonPublishStore(publishDir);
  for (const e of publishEntries) await jsonPublishEntries.record(e);

  const lineageEntries = await exportLineage(db, lineageDir);

  return {
    translations: translations.length,
    variants: variants.length,
    renderings: renderings.length,
    outletOverrides: outletOverrides.length,
    deliveries: deliveries.length,
    xArticleDeliveries: xArticleDeliveries.length,
    publishEntries: publishEntries.length,
    lineageEntries,
  };
}

/**
 * One `<itemId>.jsonl` file per item, each line appended in `ordinal` order — the same order
 * `JsonlLineageStore.append` originally wrote them in, since a plain `appendFile` (like a plain
 * `insert`) can only ever add to the end.
 */
async function exportLineage(db: Db, lineageDir: string): Promise<number> {
  const pgLineage = new PgLineageStore(db);
  const jsonLineage = new JsonlLineageStore(lineageDir);
  const items = await pgLineage.listItems();
  let count = 0;
  for (const { itemId } of items) {
    const entries = await pgLineage.load(itemId);
    for (const entry of entries) {
      await jsonLineage.append(entry);
      count += 1;
    }
  }
  return count;
}

/** Printed in pipeline order — translate → convert → format → send — the same order
 *  `stateFiles.ts`'s `describeStateDiff` uses, plus lineage (cross-cutting) last. */
function describeReport(report: ExportReport): string[] {
  return [
    `  translations           ${report.translations}`,
    `  variants                ${report.variants}`,
    `  renderings              ${report.renderings}`,
    `  outlet overrides        ${report.outletOverrides}`,
    `  deliveries              ${report.deliveries}`,
    `  x-article deliveries    ${report.xArticleDeliveries}`,
    `  publish entries         ${report.publishEntries}`,
    `  lineage entries         ${report.lineageEntries}`,
  ];
}

/**
 * The runnable entry point. Guarded so that `tests/cli/dbRoundTrip.test.ts` can `import
 * { exportOutputTree }` from this same file without also running this block — see `db-import.ts`'s
 * identical guard for why `process.argv[1] === fileURLToPath(import.meta.url)` is the right test.
 *
 * Takes an optional positional target directory (`pnpm db:export /tmp/scratch`), defaulting to the
 * real `output/` tree — the rollback destination this command exists for. Mirrors the
 * `collect`/`collect-reference`/`lineage` positional-argument convention (`process.argv[2]`, unless
 * it looks like a flag).
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  const outputRoot = process.argv[2]?.startsWith("--") ? OUTPUT_DIR : (process.argv[2] ?? OUTPUT_DIR);

  console.log(`db:export — exporting the ${cfg.env} database into ${outputRoot}`);

  const db = createDb(cfg);
  try {
    const report = await exportOutputTree(db, outputRoot);
    for (const line of describeReport(report)) console.log(line);
  } finally {
    await db.close();
  }
}
