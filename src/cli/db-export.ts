import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { applySchema, isSchemaApplied } from "../adapters/db/schema";
import { loadDbConfig } from "../config";
import { OUTPUT_DIR, REPO_ROOT } from "../paths";
import { ALL_TYPES } from "../domain/conversion/models";
import { readJsonFile, writeJsonFileAtomic } from "../shared/store/jsonFile";
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
import {
  describeCounts,
  describePreview,
  previewCount,
  type PreviewCounts,
  type StoreKey,
} from "./dbStores";
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
 * `readJsonFile<unknown[]>(path, [])` casts whatever `JSON.parse` returns without checking it is
 * actually an array. A file holding the literal `null` (or any other non-array JSON value — an
 * object, a number, a string) reads back successfully and only fails the moment `.length` is
 * accessed, as an unreadable `TypeError: Cannot read properties of null (reading 'length')` with no
 * mention of which file caused it. This validates the parsed shape and throws a message naming the
 * path instead, so a corrupt file on disk fails loud — through the same guard that exists precisely
 * to prevent silent data loss — rather than crashing `emptyOverwriteHazards` opaquely.
 */
async function readArrayLength(path: string): Promise<number> {
  const data = await readJsonFile<unknown>(path, []);
  if (!Array.isArray(data)) {
    throw new Error(
      `Expected ${path} to hold a JSON array, but it holds ${data === null ? "null" : typeof data}. ` +
        `The file may be corrupt.`,
    );
  }
  return data.length;
}

/**
 * The array/object-shaped stores whose write path above (`ensureArrayFileWritten` /
 * `ensurePublishStateWritten`) force-writes an empty file — or `{ entries: [] }` — whenever the
 * database holds zero rows for that store, **regardless of what is already on disk**. `x_threads`
 * and `lark_items` are excluded on purpose: `LocalJsonStore.upsert` / `LarkLocalStore.upsert` merge
 * the incoming (possibly empty) array into whatever the target file already holds rather than
 * replacing it, so they cannot wipe a populated file even when the database is empty — flagging them
 * here would be a false positive. `lineage` is excluded for the same reason (`exportLineage`'s
 * content-keyed dedup only ever appends).
 *
 * Reads each on-disk file directly with `readJsonFile` rather than through a `Json*` store's
 * `loadAll()` — a row count is all this needs, and `exportOutputTree` below reads through the real
 * stores anyway once this has cleared. **`deliveries.json` is the one exception** — see
 * `checkDeliveries` below.
 */
async function emptyOverwriteHazards(db: Db, outputRoot: string, configRoot: string | undefined): Promise<string[]> {
  const d = outputDirs(outputRoot);
  const hazards: string[] = [];

  const check = async (path: string, incoming: number): Promise<void> => {
    if (incoming > 0) return;
    const existing = await readArrayLength(path);
    if (existing > 0) hazards.push(`${path} (${existing} row(s) on disk, database has 0)`);
  };

  /**
   * `deliveries.json` cannot be read with the plain `readArrayLength(path)` every other store here
   * uses: on a legacy-layout tree (a populated `channels.json`, `deliveries.json` entirely absent —
   * the pre-outlet layout `db:import` still migrates on read), a raw read of `deliveries.json` alone
   * sees zero rows, this guard sees no hazard, and `ensureArrayFileWritten` then writes
   * `deliveries.json = []` — which *permanently* shadows `channels.json`, since
   * `JsonDeliveryLedger.loadAll()`'s exclusive-or only falls back to the legacy file when
   * `deliveries.json` is entirely absent. That reproduces, one layout over, the exact "empty export
   * wipes the real send history" hazard this whole guard exists to close (see `assertNoEmptyOverwrite`'s
   * doc comment) — and it is the same file `assertLedgerMigrated.ts` and `db:import` both read through
   * `JsonDeliveryLedger.loadAll()` for the identical reason. So this reads through that method too,
   * inheriting the exclusive-or rather than re-deriving it.
   */
  const checkDeliveries = async (dir: string, incoming: number): Promise<void> => {
    if (incoming > 0) return;
    const existing = (await new JsonDeliveryLedger(dir).loadAll()).length;
    if (existing > 0) {
      hazards.push(`${join(dir, "deliveries.json")} (${existing} row(s) on disk, database has 0)`);
    }
  };

  await check(join(d.translations, "translations.json"), (await new PgTranslationStore(db).loadAll()).length);
  await check(join(d.variants, "variants.json"), (await new PgConversionStore(db).loadAll()).length);
  await check(join(d.formatted, "renderings.json"), (await new PgFormattingStore(db).loadAll()).length);
  await check(join(d.formatted, "overrides.json"), (await new PgOutletOverrideStore(db).loadAll()).length);
  await checkDeliveries(d.publish, (await new PgDeliveryLedger(db).loadAll()).length);
  await check(join(d.publish, "x-article.json"), (await new PgXArticleLedger(db).loadAll()).length);

  const statePath = join(d.publish, "state.json");
  const incomingPublishEntries = (await new PgPublishStore(db).listEntries()).length;
  if (incomingPublishEntries === 0) {
    const existing = await readJsonFile<{ entries?: unknown[] }>(statePath, {});
    const existingCount = existing.entries?.length ?? 0;
    if (existingCount > 0) hazards.push(`${statePath} (${existingCount} row(s) on disk, database has 0)`);
  }

  if (configRoot) {
    const translationDir = join(configRoot, "translation");
    const conversionDir = join(configRoot, "conversion");
    await check(join(translationDir, "few-shot.json"), (await new PgFewShotStore(db, "translation").load()).length);
    const pgByType = pgFewShotStoresByType(db);
    for (const type of ALL_TYPES) {
      await check(join(conversionDir, `few-shot.${type}.json`), (await pgByType[type].load()).length);
    }
  }

  return hazards;
}

/**
 * Refuses when `emptyOverwriteHazards` finds any — the specific move that turns a fat-fingered
 * `db:export` into data loss. An empty (or wrong) database exported over a populated `output/` tree
 * would otherwise silently wipe every array-shaped store down to `[]`; that tree is simultaneously
 * `db:import`'s only input and `assertLedgerMigrated`'s only safety net, so losing it is not a
 * cosmetic mistake.
 *
 * Called before `exportOutputTree` writes anything, so a refusal here leaves *every* file on disk
 * untouched — not only the ones that would have been wiped, but the merge-safe ones too
 * (`x_threads`, `lark_items`) that a hazard discovered mid-write would otherwise still rewrite
 * (harmlessly, but rewrite nonetheless) before reaching the store that actually throws.
 *
 * `allowEmptyOverwrite` is a separate, explicit opt-in — deliberately not folded into `--yes`, so
 * the one confirmation that authorizes "write" cannot also be the one that authorizes "wipe".
 */
async function assertNoEmptyOverwrite(
  db: Db,
  outputRoot: string,
  configRoot: string | undefined,
  allowEmptyOverwrite: boolean,
): Promise<void> {
  if (allowEmptyOverwrite) return;
  const hazards = await emptyOverwriteHazards(db, outputRoot, configRoot);
  if (hazards.length === 0) return;
  throw new Error(
    `Refusing to export: the database holds zero rows for ${hazards.length} store(s) whose target file ` +
      `already holds data on disk. Exporting would overwrite it with an empty file:\n` +
      hazards.map((h) => `  - ${h}`).join("\n") +
      `\nThis is far more often a wrong or empty database (check DATABASE_URL / HERALD_DB_ENV, or run ` +
      `pnpm db:import first) than a store that was genuinely emptied. If it really was, re-run with ` +
      `--allow-empty-overwrite.`,
  );
}

export interface ExportOptions {
  /** See `assertNoEmptyOverwrite`. Defaults to `false` — export refuses an empty-over-populated
   *  overwrite unless this is passed explicitly. */
  allowEmptyOverwrite?: boolean;
}

/**
 * The rollback path. Reads each `Pg*` store — in `ordinal` order, which is insertion order (see
 * `src/adapters/db/schema.ts`) — and writes through the matching `Json*`/`Local*Store` class
 * pointed at `outputRoot` (and, for the few-shot corpus, `configRoot`), so the file it produces is
 * not a reimplementation of what `upsert`/`add`/`record`/`append` already does; it is that exact
 * code, run once per row (or, for `x_threads`/`lark_items`, once per batch — see below).
 *
 * Applies the schema (`applySchema`) first, matching `db-import.ts`'s `importOutputTree` — safe on
 * a database that already has the tables, and needed on one that does not (there is nothing to
 * export from it, but the failure should be "the database is empty", not a relation error).
 * Immediately after, `assertNoEmptyOverwrite` runs and can refuse outright — see its own doc
 * comment — before any of the writes below happen.
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
export async function exportOutputTree(
  db: Db,
  outputRoot: string,
  configRoot?: string,
  options: ExportOptions = {},
): Promise<ExportReport> {
  await applySchema(db);
  await assertNoEmptyOverwrite(db, outputRoot, configRoot, options.allowEmptyOverwrite ?? false);
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

async function countLineageOnDisk(lineageDir: string): Promise<number> {
  const items = await new JsonlLineageStore(lineageDir).listItems();
  return items.reduce((sum, i) => sum + i.entries, 0);
}

async function countLineageInDb(db: Db): Promise<number> {
  const items = await new PgLineageStore(db).listItems();
  return items.reduce((sum, i) => sum + i.entries, 0);
}

/**
 * Read-only: for every store, how many rows already sit on disk at `outputRoot` (`current` — what a
 * write would overwrite) versus how many the database holds and would write (`incoming`). This is
 * what a flagless `db:export` run prints instead of writing anything, giving it the same
 * preview-before-write shape `db:import`'s `previewImport` already has — reusing its
 * `PreviewCounts`/`describePreview` — with `current` and `incoming` naming the opposite sides,
 * because export's data flows the opposite direction.
 *
 * Coarser than `emptyOverwriteHazards`'s per-file check on purpose: `fewShotExamples` here is one
 * combined count across every `few-shot.*.json` file, matching `db:import`'s own preview shape,
 * because this function is informational (an operator deciding whether to proceed) rather than the
 * safety mechanism itself — that per-file precision lives in `assertNoEmptyOverwrite`.
 *
 * Never applies the schema, and never lets a missing one surface as a crash: every `incoming`
 * (database-side) read below goes through `previewCount` (`dbStores.ts`), which reports 0 for a
 * table that does not exist yet instead of throwing or creating it — a preview must stay
 * side-effect-free, including against a mistyped `DATABASE_URL`. `isSchemaApplied`
 * (`src/adapters/db/schema.ts`) is the separate, explicit check the entry script below uses to
 * print a "schema not applied yet" line when that is why every `incoming` count reads 0.
 */
export async function previewExport(
  db: Db,
  outputRoot: string,
  configRoot?: string,
): Promise<Record<StoreKey, PreviewCounts>> {
  const d = outputDirs(outputRoot);

  let currentFewShot = 0;
  let incomingFewShot = 0;
  if (configRoot) {
    currentFewShot += (await new JsonFewShotStore(join(configRoot, "translation")).load()).length;
    incomingFewShot += await previewCount(() => new PgFewShotStore(db, "translation").load().then((rows) => rows.length));
    const jsonByType = jsonFewShotStoresByType(join(configRoot, "conversion"));
    const pgByType = pgFewShotStoresByType(db);
    for (const type of ALL_TYPES) {
      currentFewShot += (await jsonByType[type].load()).length;
      incomingFewShot += await previewCount(() => pgByType[type].load().then((rows) => rows.length));
    }
  }

  return {
    xThreads: {
      current: (await new LocalJsonStore(d.x).loadAll()).length,
      incoming: await previewCount(() => new PgCollectionRepository(db).loadAll().then((rows) => rows.length)),
    },
    larkItems: {
      current: (await new LarkLocalStore(d.lark).loadAll()).length,
      incoming: await previewCount(() => new PgLarkRepository(db).loadAll().then((rows) => rows.length)),
    },
    translations: {
      current: (await new JsonTranslationStore(d.translations).loadAll()).length,
      incoming: await previewCount(() => new PgTranslationStore(db).loadAll().then((rows) => rows.length)),
    },
    variants: {
      current: (await new JsonConversionStore(d.variants).loadAll()).length,
      incoming: await previewCount(() => new PgConversionStore(db).loadAll().then((rows) => rows.length)),
    },
    renderings: {
      current: (await new JsonFormattingStore(d.formatted).loadAll()).length,
      incoming: await previewCount(() => new PgFormattingStore(db).loadAll().then((rows) => rows.length)),
    },
    outletOverrides: {
      current: (await new JsonOutletOverrideStore(d.formatted).loadAll()).length,
      incoming: await previewCount(() => new PgOutletOverrideStore(db).loadAll().then((rows) => rows.length)),
    },
    deliveries: {
      current: (await new JsonDeliveryLedger(d.publish).loadAll()).length,
      incoming: await previewCount(() => new PgDeliveryLedger(db).loadAll().then((rows) => rows.length)),
    },
    xArticleDeliveries: {
      current: (await new JsonXArticleLedger(d.publish).loadAll()).length,
      incoming: await previewCount(() => new PgXArticleLedger(db).loadAll().then((rows) => rows.length)),
    },
    publishEntries: {
      current: (await new JsonPublishStore(d.publish).listEntries()).length,
      incoming: await previewCount(() => new PgPublishStore(db).listEntries().then((rows) => rows.length)),
    },
    lineageEntries: {
      current: await countLineageOnDisk(d.lineage),
      incoming: await previewCount(() => countLineageInDb(db)),
    },
    fewShotExamples: { current: currentFewShot, incoming: incomingFewShot },
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
 * The runnable entry point. Guarded so that `tests/cli/dbRoundTrip.test.ts` and
 * `tests/cli/dbExport.test.ts` can `import { exportOutputTree, previewExport }` from this same file
 * without also running this block — see `db-import.ts`'s identical guard for why
 * `process.argv[1] === fileURLToPath(import.meta.url)` is the right test.
 *
 * Takes an optional positional target directory (`pnpm db:export /tmp/scratch`), defaulting to the
 * real `output/` tree — the rollback destination this command exists for. Mirrors the
 * `collect`/`collect-reference`/`lineage` positional-argument convention (`process.argv[2]`, unless
 * it looks like a flag). The few-shot corpus always exports to the real repo-root `translation/`/
 * `conversion/` config trees (`REPO_ROOT`), not under the positional target — matching
 * `db:import`'s entry script, and matching where those two directories actually live regardless of
 * where the rest of the tree is being written.
 *
 * The same preview-then-confirm shape as `db:import`: a flagless run only connects to compute and
 * print `previewExport`'s current-vs-incoming counts, and writes nothing — and, unlike the write
 * path (`exportOutputTree`), applies no DDL: `previewExport` tolerates a database whose schema was
 * never applied instead of creating it (see its own doc comment), so `isSchemaApplied` below is the
 * separate check that prints an explicit line when that is why every `incoming` count reads 0.
 * `--yes` performs the write. `--allow-empty-overwrite` is a second, separate flag on top of that —
 * see `assertNoEmptyOverwrite` — for the one legitimate case where a store really was emptied and
 * the export is meant to reflect that; `--yes` alone is not enough to authorize wiping a populated
 * file.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  const outputRoot = process.argv[2]?.startsWith("--") ? OUTPUT_DIR : (process.argv[2] ?? OUTPUT_DIR);
  const confirmed = process.argv.includes("--yes");
  const allowEmptyOverwrite = process.argv.includes("--allow-empty-overwrite");

  console.log(`db:export — exporting the ${cfg.env} database into ${outputRoot}`);

  const db = createDb(cfg);
  try {
    if (!confirmed) {
      const schemaApplied = await isSchemaApplied(db);
      const preview = await previewExport(db, outputRoot, REPO_ROOT);
      if (!schemaApplied) {
        console.log(
          `Schema not applied yet on this database — every "incoming" count below is 0 because the ` +
            `tables do not exist (there is nothing to export from it yet).`,
        );
      }
      for (const line of describePreview(preview)) console.log(line);
      console.log(`\npreview only — nothing was written.`);
      console.log(`Re-run with --yes to export into ${outputRoot}.`);
    } else {
      const report = await exportOutputTree(db, outputRoot, REPO_ROOT, { allowEmptyOverwrite });
      for (const line of describeCounts(report)) console.log(line);
    }
  } finally {
    await db.close();
  }
}
