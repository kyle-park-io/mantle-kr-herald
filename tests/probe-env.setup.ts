// Live probe tests read real credentials from process.env. The default `vitest run`
// is kept pure (no .env, no live calls); this setup file — used ONLY by
// vitest.probe.config.ts via `pnpm probe` — loads .env into process.env with Node's
// built-in loader (no dependency) so the probe describe.skipIf guards see the creds.
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
