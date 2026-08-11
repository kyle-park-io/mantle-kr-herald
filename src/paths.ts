import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, resolved from this module's own location. Deliberately NOT process.cwd():
 * relative paths made every command depend on being run from the repo root, and running one
 * from a subdirectory silently created a second output/ tree instead of failing.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Root of all pipeline artifacts. Fixed by design — see the storage design spec — with one
 * override: `HERALD_OUTPUT_DIR`, which lets `pnpm watch` (the unattended scheduler) point at its
 * own tree so a scheduled run and a hand-run local command never share the file-backed collect
 * watermark (`output/x/state.json` — deliberately not in Postgres, see `src/cli/stores.ts`). A dev
 * run once advanced that single file past threads production had not collected yet, which would
 * have made production skip them forever.
 *
 * `resolve()`d rather than used as-is for the same reason `REPO_ROOT` above is not
 * `process.cwd()`: a relative override would be invisible in the same way, silently landing under
 * whatever directory the process happened to start in instead of failing loudly. `pnpm doctor`
 * (`src/cli/doctor.ts`) reports whichever root is actually in effect, so a non-default one is never
 * silent either.
 */
export const OUTPUT_DIR = process.env.HERALD_OUTPUT_DIR
  ? resolve(process.env.HERALD_OUTPUT_DIR)
  : join(REPO_ROOT, "output");

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
  /** Where `glossary:mine` leaves its weekly review file. OUTPUT_DIR-relative, never repo-relative:
   *  it is a dated artifact of one run, not steering config, and the scheduled run must not write
   *  into the deploy checkout that `herald-deploy.sh` resets. */
  glossaryDir: join(OUTPUT_DIR, "glossary"),
  translationConfigDir: join(REPO_ROOT, "translation"),
  conversionConfigDir: join(REPO_ROOT, "conversion"),
} as const;

/**
 * The review file for one `glossary:mine` run, named by the UTC day it was mined.
 *
 * Dated rather than a single rolling `candidates.json`, because the file is something a human EDITS —
 * they delete the lines they do not want and rewrite the ones they do, over however many days it
 * takes to get to it. A fixed name means the next Monday's fire silently overwrites work in progress.
 * A same-day re-run does overwrite, which is the intended behaviour: re-mining today replaces today's
 * answer.
 */
export const glossaryCandidatesPath = (day: string): string => join(paths.glossaryDir, `candidates-${day}.json`);
