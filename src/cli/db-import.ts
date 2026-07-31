import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig, type DbConfig } from "../config";
import { OUTPUT_DIR, REPO_ROOT } from "../paths";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
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
import { type StoreCounts, type StoreKey, type PreviewCounts, describeCounts, describePreview } from "./dbStores";

export type ImportReport = StoreCounts;

/** Every incoming source read once, so `importOutputTree` (which writes it) and `previewImport`
 *  (which only counts it) cannot read the files two different ways. */
interface IncomingData {
  xThreads: Awaited<ReturnType<LocalJsonStore["loadAll"]>>;
  larkItems: Awaited<ReturnType<LarkLocalStore["loadAll"]>>;
  translations: Awaited<ReturnType<JsonTranslationStore["loadAll"]>>;
  variants: Awaited<ReturnType<JsonConversionStore["loadAll"]>>;
  renderings: Awaited<ReturnType<JsonFormattingStore["loadAll"]>>;
  outletOverrides: Awaited<ReturnType<JsonOutletOverrideStore["loadAll"]>>;
  deliveries: Awaited<ReturnType<JsonDeliveryLedger["loadAll"]>>;
  xArticleDeliveries: Awaited<ReturnType<JsonXArticleLedger["loadAll"]>>;
  publishEntries: Awaited<ReturnType<JsonPublishStore["listEntries"]>>;
  fewShotTranslation: Awaited<ReturnType<JsonFewShotStore["load"]>>;
  fewShotByType: Record<ConversionType, Awaited<ReturnType<JsonFewShotStore["load"]>>>;
}

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

/**
 * Reads every in-scope source through its existing `Json*`/`Local*Store` class, pointed at
 * `outputRoot` (and, for the few-shot corpus, `configRoot`). Never parses a file by hand: every
 * fallback a store already encodes — missing file → empty, `JsonDeliveryLedger`'s exclusive-or
 * fallback to legacy `channels.json` — is inherited for free rather than re-derived here.
 */
async function loadIncoming(outputRoot: string, configRoot: string | undefined): Promise<IncomingData> {
  const d = outputDirs(outputRoot);

  const fewShotByType = {} as Record<ConversionType, Awaited<ReturnType<JsonFewShotStore["load"]>>>;
  if (configRoot) {
    const byType = jsonFewShotStoresByType(join(configRoot, "conversion"));
    for (const type of ALL_TYPES) fewShotByType[type] = await byType[type].load();
  } else {
    for (const type of ALL_TYPES) fewShotByType[type] = [];
  }

  return {
    xThreads: await new LocalJsonStore(d.x).loadAll(),
    larkItems: await new LarkLocalStore(d.lark).loadAll(),
    translations: await new JsonTranslationStore(d.translations).loadAll(),
    variants: await new JsonConversionStore(d.variants).loadAll(),
    renderings: await new JsonFormattingStore(d.formatted).loadAll(),
    outletOverrides: await new JsonOutletOverrideStore(d.formatted).loadAll(),
    // `JsonDeliveryLedger.loadAll()` already applies the exclusive-or: `channels.json` only when
    // `deliveries.json` is entirely absent. Do not read the two files separately here.
    deliveries: await new JsonDeliveryLedger(d.publish).loadAll(),
    xArticleDeliveries: await new JsonXArticleLedger(d.publish).loadAll(),
    publishEntries: await new JsonPublishStore(d.publish).listEntries(),
    fewShotTranslation: configRoot ? await new JsonFewShotStore(join(configRoot, "translation")).load() : [],
    fewShotByType,
  };
}

/**
 * Imports the record-of-truth data under `outputRoot` — plus, when `configRoot` is given, the
 * few-shot corpus under `configRoot/translation` and `configRoot/conversion` — into `db`.
 *
 * Scope is the eleven rows of `docs/superpowers/specs/2026-07-31-hosted-writes-design.md`'s "What
 * moves" table, whose membership test is *"does the hosted dashboard read or write it?"*:
 *
 * - `x/items.json`, `lark/items.json` — `serve.ts` reads these through `CompositeContentSource`
 *   for 원문. Not rebuildable after cutover the way it looks: `CollectAuthoredContent` takes its
 *   floor from the watermark in `x/state.json` (kept **on disk** — `collect` stays a local job),
 *   so a plain `pnpm collect` post-cutover fetches nothing before that floor. Recovering the
 *   backlog means metered twitterapi.io calls, and would reconstruct `firstSeenAt`, deleted status
 *   and article `blocks` differently than the stored history — the exact regression
 *   `PgCollectionRepository`'s `mergeTweet` exists to prevent, not something a re-collect repairs.
 * - `translations/translations.json`, `variants/variants.json`, `formatted/renderings.json`,
 *   `formatted/overrides.json`, the three `publish/*.json` ledgers, `lineage/*.jsonl` — the pipeline
 *   proper.
 * - `translation/few-shot.json`, `conversion/few-shot.<type>.json` — **not** configuration despite
 *   living in the config tree: `SaveTranslation.run` and `ApproveRendering.promoteVariant` write
 *   these on every approval. After Task 17 rewires those two to `PgFewShotStore`, nothing writes
 *   the files any more, so leaving them on disk would make `config:push` keep reporting success
 *   while syncing a snapshot frozen at cutover, and `few_shot_examples` would start (and silently
 *   stay) empty for every `translate:prepare`/`convert:prepare` prompt from that point on.
 *
 * Not read through a `Json*` class directly but read here regardless: every source above is read
 * through `loadIncoming`, which is the single place this module and `previewImport` below both go
 * for "what does the tree currently hold" — so the two can never read the files two different ways.
 *
 * Every write except lineage is an upsert on the store's natural key, so re-running this against an
 * *unchanged* tree leaves the database exactly as it was. **`lineage` is the one exception**: it is
 * append-only (no natural key — see `PgLineageStore`'s doc comment), so a plain re-import would
 * duplicate every entry on a second run. `importLineage` below guards against that itself, keyed on
 * the full entry content rather than a subset of fields.
 *
 * **Import is not idempotent against a *stale* tree.** Re-running it against a tree that has not
 * changed since the last import is safe (every write above is an upsert). Re-running it after
 * cutover, against an `output/` tree that has since gone stale, is not: import never deletes, so it
 * would resurrect a row removed through the app (e.g. an unticked 전달함 delivery) and overwrite a
 * database edit with the file's older value. `db-import.ts`'s entry script below refuses outright
 * against a production database for exactly this reason — see its own refusal text.
 */
export async function importOutputTree(db: Db, outputRoot: string, configRoot?: string): Promise<ImportReport> {
  const incoming = await loadIncoming(outputRoot, configRoot);

  await new PgCollectionRepository(db).upsert(incoming.xThreads);
  await new PgLarkRepository(db).upsert(incoming.larkItems);

  const pgTranslations = new PgTranslationStore(db);
  for (const t of incoming.translations) await pgTranslations.upsert(t);

  const pgVariants = new PgConversionStore(db);
  for (const v of incoming.variants) await pgVariants.upsert(v);

  const pgRenderings = new PgFormattingStore(db);
  for (const r of incoming.renderings) await pgRenderings.upsert(r);

  const pgOutletOverrides = new PgOutletOverrideStore(db);
  for (const o of incoming.outletOverrides) await pgOutletOverrides.upsert(o);

  const pgDeliveries = new PgDeliveryLedger(db);
  for (const dEntry of incoming.deliveries) await pgDeliveries.add(dEntry);

  const pgXArticleDeliveries = new PgXArticleLedger(db);
  for (const x of incoming.xArticleDeliveries) await pgXArticleDeliveries.add(x);

  const pgPublishEntries = new PgPublishStore(db);
  for (const e of incoming.publishEntries) await pgPublishEntries.record(e);

  let fewShotExamples = 0;
  if (configRoot) {
    const pgFewShotTranslation = new PgFewShotStore(db, "translation");
    for (const ex of incoming.fewShotTranslation) await pgFewShotTranslation.add(ex);
    fewShotExamples += incoming.fewShotTranslation.length;

    const pgByType = pgFewShotStoresByType(db);
    for (const type of ALL_TYPES) {
      for (const ex of incoming.fewShotByType[type]) await pgByType[type].add(ex);
      fewShotExamples += incoming.fewShotByType[type].length;
    }
  }

  const lineageEntries = await importLineage(db, outputDirs(outputRoot).lineage);

  return {
    xThreads: incoming.xThreads.length,
    larkItems: incoming.larkItems.length,
    translations: incoming.translations.length,
    variants: incoming.variants.length,
    renderings: incoming.renderings.length,
    outletOverrides: incoming.outletOverrides.length,
    deliveries: incoming.deliveries.length,
    xArticleDeliveries: incoming.xArticleDeliveries.length,
    publishEntries: incoming.publishEntries.length,
    lineageEntries,
    fewShotExamples,
  };
}

/**
 * `lineage` has no natural key to upsert on (see `PgLineageStore`) — a plain re-`append()` of every
 * entry on a second run would duplicate the whole table. Instead, for each item, this reads what is
 * already stored and skips any incoming entry whose full content (every field, including `at`)
 * already matches a stored one, appending only what is new. That keys idempotency on the entry
 * itself rather than on a subset of fields, which is the only definition that cannot mistake two
 * genuinely different events for the same one just because they share an `itemId`.
 */
async function importLineage(db: Db, lineageDir: string): Promise<number> {
  const jsonLineage = new JsonlLineageStore(lineageDir);
  const pgLineage = new PgLineageStore(db);
  const items = await jsonLineage.listItems();
  let count = 0;
  for (const { itemId } of items) {
    const incoming = await jsonLineage.load(itemId);
    const existing = await pgLineage.load(itemId);
    const seen = new Set(existing.map((e) => JSON.stringify(e)));
    for (const entry of incoming) {
      count += 1;
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      await pgLineage.append(entry);
      seen.add(key);
    }
  }
  return count;
}

async function countLineageEntries(lineageDir: string): Promise<number> {
  const items = await new JsonlLineageStore(lineageDir).listItems();
  return items.reduce((sum, i) => sum + i.entries, 0);
}

async function countCurrentLineageEntries(db: Db): Promise<number> {
  const items = await new PgLineageStore(db).listItems();
  return items.reduce((sum, i) => sum + i.entries, 0);
}

/**
 * Read-only: for every store, how many rows the database already holds versus how many the
 * output tree (and, when `configRoot` is given, the config tree) would bring in. This is what a
 * flagless `db:import` run prints instead of writing anything — see the entry script below — so an
 * operator sees the change before confirming it, the same shape `state:pull`'s preview gives.
 */
export async function previewImport(
  db: Db,
  outputRoot: string,
  configRoot?: string,
): Promise<Record<StoreKey, PreviewCounts>> {
  const incoming = await loadIncoming(outputRoot, configRoot);
  const lineageDir = outputDirs(outputRoot).lineage;

  let currentFewShot = 0;
  if (configRoot) {
    currentFewShot += (await new PgFewShotStore(db, "translation").load()).length;
    const pgByType = pgFewShotStoresByType(db);
    for (const type of ALL_TYPES) currentFewShot += (await pgByType[type].load()).length;
  }
  const incomingFewShot =
    incoming.fewShotTranslation.length + ALL_TYPES.reduce((sum, type) => sum + incoming.fewShotByType[type].length, 0);

  return {
    xThreads: { current: (await new PgCollectionRepository(db).loadAll()).length, incoming: incoming.xThreads.length },
    larkItems: { current: (await new PgLarkRepository(db).loadAll()).length, incoming: incoming.larkItems.length },
    translations: {
      current: (await new PgTranslationStore(db).loadAll()).length,
      incoming: incoming.translations.length,
    },
    variants: { current: (await new PgConversionStore(db).loadAll()).length, incoming: incoming.variants.length },
    renderings: { current: (await new PgFormattingStore(db).loadAll()).length, incoming: incoming.renderings.length },
    outletOverrides: {
      current: (await new PgOutletOverrideStore(db).loadAll()).length,
      incoming: incoming.outletOverrides.length,
    },
    deliveries: { current: (await new PgDeliveryLedger(db).loadAll()).length, incoming: incoming.deliveries.length },
    xArticleDeliveries: {
      current: (await new PgXArticleLedger(db).loadAll()).length,
      incoming: incoming.xArticleDeliveries.length,
    },
    publishEntries: {
      current: (await new PgPublishStore(db).listEntries()).length,
      incoming: incoming.publishEntries.length,
    },
    lineageEntries: { current: await countCurrentLineageEntries(db), incoming: await countLineageEntries(lineageDir) },
    fewShotExamples: { current: currentFewShot, incoming: incomingFewShot },
  };
}

/** `host:port/dbname` — never the credentials embedded in `DATABASE_URL`. */
function describeTarget(cfg: DbConfig): string {
  const url = new URL(cfg.url);
  const database = url.pathname.replace(/^\//, "");
  return `${cfg.env} database ${url.hostname}${url.port ? `:${url.port}` : ""}/${database}`;
}

/**
 * The runnable entry point. Guarded so that `tests/cli/dbImport.test.ts` can `import
 * { importOutputTree }` from this same file (per the plan) without also running this block —
 * `process.argv[1]` is the script Node was actually invoked with, which is `vitest`'s own runner
 * when this module is loaded as a test dependency, and this file's own path only when it is run
 * directly (`tsx src/cli/db-import.ts`, i.e. `pnpm db:import`).
 *
 * A flagless run never writes: it connects only to read current counts, prints them beside what
 * the tree would bring in, and stops — modeled on `state:pull`'s preview, so an operator sees what
 * is about to change before changing it, in *every* environment, not only production. `--yes` is
 * what performs the write. Production additionally refuses outright without `--yes`, after showing
 * the same preview, because of the stale-tree hazard the refusal text below explains.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  const target = describeTarget(cfg);
  const confirmed = process.argv.includes("--yes");

  console.log(`db:import — ${target}`);

  const db = createDb(cfg);
  try {
    if (!confirmed) {
      const preview = await previewImport(db, OUTPUT_DIR, REPO_ROOT);
      for (const line of describePreview(preview)) console.log(line);
      console.log(`\npreview only — nothing was written.`);
      if (cfg.env === "production") {
        throw new Error(
          `Refusing to import into the production database without --yes.\n` +
            `This is not safe to re-run casually: import only ever upserts or appends, it never deletes. ` +
            `Run it against a stale output/ tree — one that has drifted since a previous cutover — and it ` +
            `will resurrect rows removed through the app (e.g. an unticked 전달함 delivery) and overwrite ` +
            `database edits with the file's older values. Only pass --yes for the deliberate, ` +
            `human-supervised migration this command exists for.`,
        );
      }
      console.log(`Re-run with --yes to import into the ${target}.`);
    } else {
      const report = await importOutputTree(db, OUTPUT_DIR, REPO_ROOT);
      for (const line of describeCounts(report)) console.log(line);
    }
  } finally {
    await db.close();
  }
}
