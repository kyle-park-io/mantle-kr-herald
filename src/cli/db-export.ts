import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { OUTPUT_DIR, REPO_ROOT } from "../paths";
import { ALL_TYPES } from "../domain/conversion/models";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { LarkLocalStore } from "../adapters/lark/LarkLocalStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonOutletOverrideStore } from "../adapters/store/JsonOutletOverrideStore";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { fewShotStoresByType as jsonFewShotStoresByType } from "../adapters/store/JsonTypedFewShotStore";
import { PgCollectionRepository } from "../adapters/store/PgCollectionRepository";
import { PgLarkRepository } from "../adapters/store/PgLarkRepository";
import { PgTranslationStore } from "../adapters/store/PgTranslationStore";
import { PgConversionStore } from "../adapters/store/PgConversionStore";
import { PgFormattingStore } from "../adapters/store/PgFormattingStore";
import { PgOutletOverrideStore } from "../adapters/store/PgOutletOverrideStore";
import { PgDeliveryLedger } from "../adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../adapters/store/PgXArticleLedger";
import { PgPublishStore } from "../adapters/store/PgPublishStore";
import { PgLineageStore } from "../adapters/store/PgLineageStore";
import { PgFewShotStore, fewShotStoresByType as pgFewShotStoresByType } from "../adapters/store/PgFewShotStore";
import { describeCounts } from "./dbStores";
import type { ImportReport } from "./db-import";

/**
 * Deliberately `ImportReport`, not a second independently-declared interface: `db:export`'s job is
 * to be the rollback path for exactly what `db:import` carries, so "whatever import carries, export
 * must return" is enforced here as a type identity rather than left as a comment the two files
 * could quietly drift apart on. Add a store to `StoreCounts` (`src/cli/dbStores.ts`) and both
 * `importOutputTree` and `exportOutputTree` fail to typecheck until they populate it.
 */
export type ExportReport = ImportReport;

function outputDirs(outputRoot: string) {
  return {
    x: join(outputRoot, "x"),
    lark: join(outputRoot, "lark"),
    translations: join(outputRoot, "translations"),
    variants: join(outputRoot, "variants"),
    formatted: join(outputRoot, "formatted"),
    publish: join(outputRoot, "publish"),
    lineage: join(outputRoot, "lineage"),
  };
}

/** Writes `[]` directly when `rows` is empty, since every `Json*` store's write method is a
 *  per-row upsert that is simply never called for zero rows — leaving *no file* rather than an
 *  empty array. That absence is not neutral: for `deliveries.json` specifically, an absent file
 *  leaves `JsonDeliveryLedger.loadAll()` free to fall back to a `channels.json` this export never
 *  wrote (the legacy file `db:export` never produces), turning a "database has zero deliveries"
 *  export into a tree that can silently resurrect a stale legacy ledger the moment one is dropped
 *  in beside it. Writing `[]` explicitly closes that off for every array-shaped store, not only
 *  deliveries: an exported file always reflects "the database has zero rows", never "this store
 *  was never initialized". Bypasses the store's own write method for this one case only — `[]` is
 *  the exact literal every one of these stores already produces for zero rows, so this reproduces
 *  their serialisation rather than reimplementing it.
 */
async function ensureArrayFileWritten(dir: string, filename: string, rowCount: number): Promise<void> {
  if (rowCount > 0) return;
  await writeJsonFileAtomic(dir, join(dir, filename), []);
}

/** Same reasoning as `ensureArrayFileWritten`, for `publish/state.json`'s `{ entries: [...] }`
 *  shape (`JsonPublishStore`'s `StateFile`) rather than a bare array. */
async function ensurePublishStateWritten(dir: string, rowCount: number): Promise<void> {
  if (rowCount > 0) return;
  await writeJsonFileAtomic(dir, join(dir, "state.json"), { entries: [] });
}

/**
 * The rollback path. Reads each `Pg*` store — in `ordinal` order, which is insertion order (see
 * `src/adapters/db/schema.ts`) — and writes through the matching `Json*`/`Local*Store` class
 * pointed at `outputRoot` (and, for the few-shot corpus, `configRoot`), so the file it produces is
 * not a reimplementation of what `upsert`/`add`/`record`/`append` already does; it is that exact
 * code, run once per row (or, for `x_threads`/`lark_items`, once per batch — see below).
 *
 * That reuse is what makes the round trip in `tests/cli/dbRoundTrip.test.ts` byte-for-byte: the
 * same `writeJsonFileAtomic` call (2-space `JSON.stringify` plus a trailing newline) that
 * originally wrote e.g. `translations.json` writes it again here, over the same
 * in-declaration-order object shape each `Pg*` store's mapper already builds, with `omitNulls`
 * dropping — not nulling — an absent optional field, and rows visited in `ordinal` order so a
 * `Map`-based upsert like `JsonTranslationStore.upsert`'s never has anything to reorder.
 *
 * `x_threads` and `lark_items` are written through `LocalJsonStore.upsert(threads)` /
 * `LarkLocalStore.upsert(messages)` **once, with the whole array**, rather than looped per row like
 * every other store here — matching those two stores' own multi-row API (mirroring
 * `PgCollectionRepository.upsert`/`PgLarkRepository.upsert`, which take arrays for the same reason:
 * `x_threads`' merge rule needs the whole incoming batch, not one row at a time). That also means
 * they need no `ensureArrayFileWritten` special case: unlike a per-row loop, `upsert([])` still
 * always writes, so an empty result already produces `[]` on its own.
 *
 * Mirrors `importOutputTree`'s scope exactly, by construction (`ExportReport = ImportReport`) — see
 * that function's doc comment for why each of the eleven stores is in scope.
 *
 * Assumes `outputRoot`/`configRoot` are not carrying *stale* content of their own beyond what this
 * function itself dedupes against — a fresh directory (as every test here uses), or the real
 * `output/`/repo-root trees, which nothing else writes to post-cutover (Task 17 points every other
 * command at `Pg*` stores, leaving `db:export` "the one place that must still write files"). Each
 * `Json*` store's `upsert`/`add`/`record` merges by natural key against whatever the file already
 * holds, so a row present in a stale target file but no longer present in the database (deleted
 * through the app after cutover) would survive an export into that file untouched — the mirror of
 * `db:import`'s own documented "not idempotent against a stale tree" warning, for the opposite
 * direction, and not something this function defends against. Lineage is the one place this
 * function *does* defend against re-running into the same tree — see `exportLineage` below — because
 * running `db:export` at all against its own real default target (`output/`, which still holds every
 * pre-cutover `lineage/*.jsonl` line `db:import` read) is exactly the "unchanged tree" case, not an
 * edge case reached only by re-running twice.
 */
export async function exportOutputTree(db: Db, outputRoot: string, configRoot?: string): Promise<ExportReport> {
  const d = outputDirs(outputRoot);

  const xThreads = await new PgCollectionRepository(db).loadAll();
  await new LocalJsonStore(d.x).upsert(xThreads);

  const larkItems = await new PgLarkRepository(db).loadAll();
  await new LarkLocalStore(d.lark).upsert(larkItems);

  const translations = await new PgTranslationStore(db).loadAll();
  const jsonTranslations = new JsonTranslationStore(d.translations);
  for (const t of translations) await jsonTranslations.upsert(t);
  await ensureArrayFileWritten(d.translations, "translations.json", translations.length);

  const variants = await new PgConversionStore(db).loadAll();
  const jsonVariants = new JsonConversionStore(d.variants);
  for (const v of variants) await jsonVariants.upsert(v);
  await ensureArrayFileWritten(d.variants, "variants.json", variants.length);

  const renderings = await new PgFormattingStore(db).loadAll();
  const jsonRenderings = new JsonFormattingStore(d.formatted);
  for (const r of renderings) await jsonRenderings.upsert(r);
  await ensureArrayFileWritten(d.formatted, "renderings.json", renderings.length);

  const outletOverrides = await new PgOutletOverrideStore(db).loadAll();
  const jsonOutletOverrides = new JsonOutletOverrideStore(d.formatted);
  for (const o of outletOverrides) await jsonOutletOverrides.upsert(o);
  await ensureArrayFileWritten(d.formatted, "overrides.json", outletOverrides.length);

  const deliveries = await new PgDeliveryLedger(db).loadAll();
  const jsonDeliveries = new JsonDeliveryLedger(d.publish);
  for (const dEntry of deliveries) await jsonDeliveries.add(dEntry);
  await ensureArrayFileWritten(d.publish, "deliveries.json", deliveries.length);

  const xArticleDeliveries = await new PgXArticleLedger(db).loadAll();
  const jsonXArticleDeliveries = new JsonXArticleLedger(d.publish);
  for (const x of xArticleDeliveries) await jsonXArticleDeliveries.add(x);
  await ensureArrayFileWritten(d.publish, "x-article.json", xArticleDeliveries.length);

  const publishEntries = await new PgPublishStore(db).listEntries();
  const jsonPublishEntries = new JsonPublishStore(d.publish);
  for (const e of publishEntries) await jsonPublishEntries.record(e);
  await ensurePublishStateWritten(d.publish, publishEntries.length);

  let fewShotExamples = 0;
  if (configRoot) {
    const translationDir = join(configRoot, "translation");
    const conversionDir = join(configRoot, "conversion");

    const fewShotTranslation = await new PgFewShotStore(db, "translation").load();
    const jsonFewShotTranslation = new JsonFewShotStore(translationDir);
    for (const ex of fewShotTranslation) await jsonFewShotTranslation.add(ex);
    await ensureArrayFileWritten(translationDir, "few-shot.json", fewShotTranslation.length);
    fewShotExamples += fewShotTranslation.length;

    const pgByType = pgFewShotStoresByType(db);
    const jsonByType = jsonFewShotStoresByType(conversionDir);
    for (const type of ALL_TYPES) {
      const examples = await pgByType[type].load();
      for (const ex of examples) await jsonByType[type].add(ex);
      await ensureArrayFileWritten(conversionDir, `few-shot.${type}.json`, examples.length);
      fewShotExamples += examples.length;
    }
  }

  const lineageEntries = await exportLineage(db, d.lineage);

  return {
    xThreads: xThreads.length,
    larkItems: larkItems.length,
    translations: translations.length,
    variants: variants.length,
    renderings: renderings.length,
    outletOverrides: outletOverrides.length,
    deliveries: deliveries.length,
    xArticleDeliveries: xArticleDeliveries.length,
    publishEntries: publishEntries.length,
    lineageEntries,
    fewShotExamples,
  };
}

/**
 * One `<itemId>.jsonl` file per item, each line appended in `ordinal` order — the same order
 * `JsonlLineageStore.append` originally wrote them in, since a plain `appendFile` (like a plain
 * `insert`) can only ever add to the end.
 *
 * Content-keyed dedup, mirroring `db-import.ts`'s `importLineage`: for each item, this reads
 * whatever the target file already holds and skips any row whose full content already matches one
 * on disk, appending only what is new. Without this, exporting into a tree that still holds the
 * lines `db:import` originally read from it — which is exactly what running `db:export` against its
 * own real default target (`output/`) looks like, not merely a hazard on a *second* run — would
 * append every one of them a second time on top of itself, doubling every `lineage/*.jsonl` file's
 * line count.
 */
async function exportLineage(db: Db, lineageDir: string): Promise<number> {
  const pgLineage = new PgLineageStore(db);
  const jsonLineage = new JsonlLineageStore(lineageDir);
  const items = await pgLineage.listItems();
  let count = 0;
  for (const { itemId } of items) {
    const outgoing = await pgLineage.load(itemId);
    const existing = await jsonLineage.load(itemId);
    const seen = new Set(existing.map((e) => JSON.stringify(e)));
    for (const entry of outgoing) {
      count += 1;
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      await jsonLineage.append(entry);
      seen.add(key);
    }
  }
  return count;
}

/**
 * The runnable entry point. Guarded so that `tests/cli/dbRoundTrip.test.ts` can `import
 * { exportOutputTree }` from this same file without also running this block — see `db-import.ts`'s
 * identical guard for why `process.argv[1] === fileURLToPath(import.meta.url)` is the right test.
 *
 * Takes an optional positional target directory (`pnpm db:export /tmp/scratch`), defaulting to the
 * real `output/` tree — the rollback destination this command exists for. Mirrors the
 * `collect`/`collect-reference`/`lineage` positional-argument convention (`process.argv[2]`, unless
 * it looks like a flag). The few-shot corpus always exports to the real repo-root `translation/`/
 * `conversion/` config trees (`REPO_ROOT`), not under the positional target — matching
 * `db:import`'s entry script, and matching where those two directories actually live regardless of
 * where the rest of the tree is being written.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  const outputRoot = process.argv[2]?.startsWith("--") ? OUTPUT_DIR : (process.argv[2] ?? OUTPUT_DIR);

  console.log(`db:export — exporting the ${cfg.env} database into ${outputRoot}`);

  const db = createDb(cfg);
  try {
    const report = await exportOutputTree(db, outputRoot, REPO_ROOT);
    for (const line of describeCounts(report)) console.log(line);
  } finally {
    await db.close();
  }
}
