import { defineConfig } from "vitest/config";

/**
 * The default `vitest run`/`vitest` config — everything except `pnpm probe`, which has its own
 * (`vitest.probe.config.ts`).
 *
 * `testTimeout`/`hookTimeout` are raised from Vitest's 5000ms default: this suite's `Pg*Store` and
 * `db:import`/`db:export` tests each spin up a fresh in-memory PGlite instance (`createTestDb()`),
 * and running the full suite runs ~190 files' worth of those in parallel. Individually most finish
 * in 1-2s, but under that parallel load — every worker's PGlite instances contending for the same
 * CPU cores — a single test's real work can comfortably exceed 5s with nothing wrong with the test
 * itself; empirically, raising this value alone (with no other change) was enough to make the whole
 * suite pass reliably. Do not "fix" a slow individual test by adding a per-`it()` timeout instead —
 * that treats a shared, environmental cause as if it belonged to one file.
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
