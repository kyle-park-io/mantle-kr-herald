import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig, type DbConfig } from "../config";
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

/** Per-store row counts, in pipeline order — see `describe()` below. */
export interface ImportReport {
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
 * Imports the record-of-truth data under `outputRoot` into `db`.
 *
 * Every store is read through its **existing `Json*` class**, pointed at `outputRoot`, rather than
 * parsed by hand — that is what makes an absent file "zero rows" instead of a thrown error (every
 * `Json*` store already falls back to `[]`/`{}` on `ENOENT`) and, for the delivery ledger, is what
 * keeps the legacy `channels.json` fallback **exclusive** rather than additive: `JsonDeliveryLedger
 * .loadAll()` returns `channels.json` only when `deliveries.json` is absent, never both, and reading
 * through that method inherits the rule instead of re-deriving it (and risking getting it wrong in
 * the direction that resurrects a `remove()`d row or turns a `dropped` send back into `sent`).
 *
 * Every write below is an `upsert` on the store's natural key, so re-running this against an
 * *unchanged* tree leaves the database exactly as it was — `translations`, `variants`, `renderings`,
 * `outlet_overrides`, `deliveries`, `x_article_deliveries` and `publish_entries` are all keyed that
 * way. **`lineage` is the one exception**: it is append-only (no natural key — see
 * `PgLineageStore`'s doc comment), so a plain re-import would duplicate every entry on a second run.
 * `importLineage` below guards against that itself, keyed on the full entry content rather than a
 * subset of fields.
 *
 * Scope is the seven files `state:push` tracks (`src/cli/stateFiles.ts`'s `TRACKED` list) plus
 * `formatted/renderings.json` and `lineage/`. Renderings are not in `TRACKED` — `state:push`'s own
 * doc comment calls them regenerable, since `format` is pure code over `variants` — but the §7
 * second-review `approved` flag on a rendering is real reviewer work with no re-derivation, so it is
 * migrated here even though the text underneath it is not irreplaceable. `lineage` is excluded from
 * `TRACKED` for a different reason (unbounded growth) that does not apply to a one-time import.
 *
 * Deliberately **out of scope**, and not attempted here:
 * - Few-shot/glossary corpora (`translation/few-shot.json`, `tm.json`, `glossary.json`,
 *   `conversion/few-shot.<type>.json`): these live under `paths.translationConfigDir` /
 *   `paths.conversionConfigDir` at the repo root, not under `outputRoot` — they are **config**,
 *   already round-tripped by `config:push`/`config:pull`, not pipeline state.
 * - Collected content (`x/items.json`, Lark messages): `stateFiles.ts` already documents
 *   `x/items.json` as rebuildable ("re-collects — same source, same output. Out."), and there is no
 *   `Pg*` store yet that writes Lark items, so there is nothing to migrate them into.
 *
 * **Import is not idempotent against a *stale* tree.** Re-running it against a tree that has not
 * changed since the last import is safe (every write above is an upsert). Re-running it after
 * cutover, against an `output/` tree that has since gone stale, is not: import never deletes, so it
 * would resurrect a row removed through the app (e.g. an unticked 전달함 delivery) and overwrite a
 * database edit with the file's older value. `db-import.ts`'s entry script below refuses outright
 * against a production database for exactly this reason — see its own refusal text.
 */
export async function importOutputTree(db: Db, outputRoot: string): Promise<ImportReport> {
  const translationsDir = join(outputRoot, "translations");
  const variantsDir = join(outputRoot, "variants");
  const formattedDir = join(outputRoot, "formatted");
  const publishDir = join(outputRoot, "publish");
  const lineageDir = join(outputRoot, "lineage");

  const translations = await new JsonTranslationStore(translationsDir).loadAll();
  const pgTranslations = new PgTranslationStore(db);
  for (const t of translations) await pgTranslations.upsert(t);

  const variants = await new JsonConversionStore(variantsDir).loadAll();
  const pgVariants = new PgConversionStore(db);
  for (const v of variants) await pgVariants.upsert(v);

  const renderings = await new JsonFormattingStore(formattedDir).loadAll();
  const pgRenderings = new PgFormattingStore(db);
  for (const r of renderings) await pgRenderings.upsert(r);

  const outletOverrides = await new JsonOutletOverrideStore(formattedDir).loadAll();
  const pgOutletOverrides = new PgOutletOverrideStore(db);
  for (const o of outletOverrides) await pgOutletOverrides.upsert(o);

  // `JsonDeliveryLedger.loadAll()` already applies the exclusive-or: `channels.json` only when
  // `deliveries.json` is entirely absent. Do not read the two files separately here.
  const deliveries = await new JsonDeliveryLedger(publishDir).loadAll();
  const pgDeliveries = new PgDeliveryLedger(db);
  for (const d of deliveries) await pgDeliveries.add(d);

  const xArticleDeliveries = await new JsonXArticleLedger(publishDir).loadAll();
  const pgXArticleDeliveries = new PgXArticleLedger(db);
  for (const x of xArticleDeliveries) await pgXArticleDeliveries.add(x);

  const publishEntries = await new JsonPublishStore(publishDir).listEntries();
  const pgPublishEntries = new PgPublishStore(db);
  for (const e of publishEntries) await pgPublishEntries.record(e);

  const lineageEntries = await importLineage(db, lineageDir);

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

/** `host:port/dbname` — never the credentials embedded in `DATABASE_URL`. */
function describeTarget(cfg: DbConfig): string {
  const url = new URL(cfg.url);
  const database = url.pathname.replace(/^\//, "");
  return `${cfg.env} database ${url.hostname}${url.port ? `:${url.port}` : ""}/${database}`;
}

/** Printed in pipeline order — translate → convert → format → send — the same order
 *  `stateFiles.ts`'s `describeStateDiff` uses, plus lineage (cross-cutting) last. */
function describeReport(report: ImportReport): string[] {
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
 * The runnable entry point. Guarded so that `tests/cli/dbImport.test.ts` can `import
 * { importOutputTree }` from this same file (per the plan) without also running this block —
 * `process.argv[1]` is the script Node was actually invoked with, which is `vitest`'s own runner
 * when this module is loaded as a test dependency, and this file's own path only when it is run
 * directly (`tsx src/cli/db-import.ts`, i.e. `pnpm db:import`).
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  const target = describeTarget(cfg);
  const confirmed = process.argv.includes("--yes");

  console.log(`db:import — importing ${OUTPUT_DIR} into the ${target}`);

  if (cfg.env === "production" && !confirmed) {
    throw new Error(
      `Refusing to import into the production database without --yes.\n` +
        `This is not safe to re-run casually: import only ever upserts or appends, it never deletes. ` +
        `Run it against a stale output/ tree — one that has drifted since a previous cutover — and it ` +
        `will resurrect rows removed through the app (e.g. an unticked 전달함 delivery) and overwrite ` +
        `database edits with the file's older values. Only pass --yes for the deliberate, ` +
        `human-supervised migration this command exists for.`,
    );
  }

  const db = createDb(cfg);
  try {
    const report = await importOutputTree(db, OUTPUT_DIR);
    for (const line of describeReport(report)) console.log(line);
  } finally {
    await db.close();
  }
}
