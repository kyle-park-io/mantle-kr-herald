import { defineConfig } from "vitest/config";

/**
 * The default `vitest run`/`vitest` config — everything except `pnpm probe`, which has its own
 * (`vitest.probe.config.ts`).
 *
 * `testTimeout`/`hookTimeout` were once raised from Vitest's 5000ms default to work around
 * `createTestDb()` contention (every `Pg*Store` and `db:import`/`db:export` test booting its own
 * PGlite instance, all ~190 files' worth running in parallel). That masked the symptom rather than
 * fixing it — the suite grew past ~1860 tests and the timeout started tripping again, this time
 * un-raisable without also making a genuinely hung test take even longer to report. The real fix was
 * the cause, not the number: `createTestDb()` (`tests/support/testDb.ts`) now pools schema-applied
 * PGlite engines instead of booting a fresh one per call — a `new PGlite()` is cheap, but the first
 * query against one pays a one-time ~2-3s WASM bootstrap regardless of how trivial that query is, so
 * 200+ fresh engines per run was 200+ of those. Pooling collapses that to roughly one engine per test
 * *file* (two for `tests/app/stateRoundTrip.test.ts`, the one file that ever holds two `createTestDb()`
 * results live at once), cutting full-run engine boots from ~208 to ~35.
 *
 * That alone was not quite enough under this suite's own worst-case scheduling: when several of the
 * ~27 `createTestDb()`-using files happen to start at once, their engine boots still compete hard
 * enough for the CPU to occasionally push one past 20s. `maxForks` below trades a little of that
 * parallelism back for headroom — capping how many of those boots can be genuinely concurrent — and
 * empirically costs nothing: total wall-clock is within noise of running unrestricted (default
 * `maxForks` is the CPU count) because this suite was never CPU-bound enough to need every core at
 * once, and a still-contended run just under 20s stopped happening across repeated full-suite runs.
 * Do not "fix" a slow individual test by adding a per-`it()` timeout instead — that treats a shared,
 * environmental cause as if it belonged to one file.
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 6,
      },
    },
  },
});
