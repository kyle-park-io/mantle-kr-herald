import { defineConfig } from "vitest/config";

// Config for live probe tests only: `pnpm probe`.
// Loads .env (via the setup file) and runs only *.probe.test.ts, which self-skip
// unless the matching credentials are present. The default `vitest run` does NOT
// use this config, so ordinary unit runs never touch live services.
export default defineConfig({
  test: {
    include: ["tests/**/*.probe.test.ts"],
    setupFiles: ["tests/probe-env.setup.ts"],
  },
});
