// tests/cli/serveStartupOrder.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SERVE_ENTRY = join(REPO_ROOT, "src", "cli", "serve.ts");

/**
 * Pins `serve.ts`'s fail-fast startup order: config that only ever throws — a missing/short
 * `HERALD_SESSION_SECRET`, an invalid `HERALD_TRUST_PROXY_HOPS`, no dashboard account configured —
 * must be validated before the process ever opens the database pool, applies the schema, or queries
 * the ledger tables. That ordering is invisible to every other test in this suite: `createDeps.ts`
 * itself re-runs the same three loaders (the hosted entry point needs them too), so a unit-level
 * `ApiDeps`/`handleApi` test cannot distinguish "validated first" from "validated only once
 * `createDeps` gets around to it, after `applySchema`/`assertLedgerMigrated` already ran real
 * queries" — both eventually produce the same refusal. Only spawning the real entry point and
 * racing the two possible failures against each other tells them apart.
 *
 * `DATABASE_URL` points at 127.0.0.1:1 — nothing listens there, so a real connection attempt fails
 * near-instantly with `ECONNREFUSED` rather than hanging; this test does not rely on a timeout to
 * distinguish the two orderings, only on which message comes out. No `HERALD_AUTH_USERNAME`/
 * `HERALD_AUTH_PASSWORD_HASH` is set, so the correct order refuses with the account message, naming
 * `pnpm auth:hash`, having never touched the database at all.
 *
 * Deliberately does not go through `pnpm serve` (`tsx --env-file-if-exists=.env …`): that flag
 * would load the real `.env` — Kyle's production credentials — into this process, which could mask
 * the very condition ("no account configured") this test sets up, or point `DATABASE_URL` at a real
 * database. `tsx` is invoked directly instead, with an explicit, minimal env.
 */
describe("serve.ts startup order", () => {
  it("refuses a missing account before ever opening the database pool", async () => {
    const child = spawn(TSX_BIN, [SERVE_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: "postgres://user:pass@127.0.0.1:1/nonexistent",
        HERALD_DB_ENV: "development",
        HERALD_SESSION_SECRET: "test-only-session-secret-do-not-use-in-prod!!!!",
        // HERALD_AUTH_USERNAME / HERALD_AUTH_PASSWORD_HASH deliberately absent — no account.
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.resume(); // drain, unused

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No dashboard account configured");
    expect(stderr).toContain("pnpm auth:hash");
    expect(stderr).not.toMatch(/ECONNREFUSED/);
  }, 20000);
});
