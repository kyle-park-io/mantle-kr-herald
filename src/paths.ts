import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, resolved from this module's own location. Deliberately NOT process.cwd():
 * relative paths made every command depend on being run from the repo root, and running one
 * from a subdirectory silently created a second output/ tree instead of failing.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Root of all pipeline artifacts. Fixed by design — see the storage design spec. */
export const OUTPUT_DIR = join(REPO_ROOT, "output");

export const paths = {
  xDir: join(OUTPUT_DIR, "x"),
  xItems: join(OUTPUT_DIR, "x", "items.json"),
  xRuns: join(OUTPUT_DIR, "x", "runs.json"),
  referenceDir: join(OUTPUT_DIR, "x", "reference"),
  referenceItems: join(OUTPUT_DIR, "x", "reference", "items.json"),
  referenceRuns: join(OUTPUT_DIR, "x", "reference", "runs.json"),
  referencePairsProposed: join(OUTPUT_DIR, "x", "reference", "pairs-proposed.json"),
  referencePairsReview: join(OUTPUT_DIR, "x", "reference", "pairs-review.md"),
  larkDir: join(OUTPUT_DIR, "lark"),
  larkItems: join(OUTPUT_DIR, "lark", "items.json"),
  translationsDir: join(OUTPUT_DIR, "translations"),
  /** What `JsonTranslationStore` writes — the 1차 Korean text and its approval. Tracked by `state:push`. */
  translationsStore: join(OUTPUT_DIR, "translations", "translations.json"),
  translationsPending: join(OUTPUT_DIR, "translations", "pending.json"),
  translationsWorksheets: join(OUTPUT_DIR, "translations", "worksheets"),
  variantsDir: join(OUTPUT_DIR, "variants"),
  /** What `JsonConversionStore` writes — the per-type converted copy. Tracked by `state:push`. */
  variantsStore: join(OUTPUT_DIR, "variants", "variants.json"),
  variantsPending: join(OUTPUT_DIR, "variants", "pending.json"),
  variantsWorksheets: join(OUTPUT_DIR, "variants", "worksheets"),
  formattedDir: join(OUTPUT_DIR, "formatted"),
  formattedPending: join(OUTPUT_DIR, "formatted", "pending.json"),
  formattedWorksheets: join(OUTPUT_DIR, "formatted", "worksheets"),
  formattedOverrides: join(OUTPUT_DIR, "formatted", "overrides.json"),
  publishDir: join(OUTPUT_DIR, "publish"),
  publishLocalDir: join(OUTPUT_DIR, "publish", "local"),
  publishDeliveries: join(OUTPUT_DIR, "publish", "deliveries.json"),
  /** Pre-outlet send ledger. `JsonDeliveryLedger` still reads it when `deliveries.json` is absent. */
  publishChannelsLegacy: join(OUTPUT_DIR, "publish", "channels.json"),
  publishXArticle: join(OUTPUT_DIR, "publish", "x-article.json"),
  publishState: join(OUTPUT_DIR, "publish", "state.json"),
  archiveDir: join(OUTPUT_DIR, "archive"),
  lineageDir: join(OUTPUT_DIR, "lineage"),
  translationConfigDir: join(REPO_ROOT, "translation"),
  conversionConfigDir: join(REPO_ROOT, "conversion"),
} as const;
