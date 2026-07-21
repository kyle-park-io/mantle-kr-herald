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
  larkDir: join(OUTPUT_DIR, "lark"),
  larkItems: join(OUTPUT_DIR, "lark", "items.json"),
  translationsDir: join(OUTPUT_DIR, "translations"),
  translationsPending: join(OUTPUT_DIR, "translations", "pending.json"),
  translationsWorksheets: join(OUTPUT_DIR, "translations", "worksheets"),
  variantsDir: join(OUTPUT_DIR, "variants"),
  variantsPending: join(OUTPUT_DIR, "variants", "pending.json"),
  variantsWorksheets: join(OUTPUT_DIR, "variants", "worksheets"),
  formattedDir: join(OUTPUT_DIR, "formatted"),
  formattedPending: join(OUTPUT_DIR, "formatted", "pending.json"),
  formattedWorksheets: join(OUTPUT_DIR, "formatted", "worksheets"),
  publishDir: join(OUTPUT_DIR, "publish"),
  publishLocalDir: join(OUTPUT_DIR, "publish", "local"),
  archiveDir: join(OUTPUT_DIR, "archive"),
  translationConfigDir: join(REPO_ROOT, "translation"),
  conversionConfigDir: join(REPO_ROOT, "conversion"),
} as const;
