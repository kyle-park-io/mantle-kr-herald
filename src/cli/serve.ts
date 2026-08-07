import "./registerErrorHandler";
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import { createDb } from "../adapters/db/createDb";
import { applySchema } from "../adapters/db/schema";
import { assertLedgerMigrated } from "./assertLedgerMigrated";
import { startReconcileScheduler } from "./reconcileScheduler";
import { loadDbConfig, loadTypefullyConfig, loadSessionConfig, loadClientIpConfig, loadAuthConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { REPO_ROOT, OUTPUT_DIR, paths } from "../paths";
import { createDeps } from "../app/createDeps";

const port = Number(process.env.PORT) || 5757;
const dbConfig = loadDbConfig();

// Printed BEFORE anything connects, which is the whole point: `pnpm status`, `pnpm watch`,
// `pnpm x:reconcile` and `pnpm db:migrate` all name their database on their first line, and this
// long-lived, write-capable board — the one place a human approves copy — was the only entry point
// that did not. A server that comes up silently gives no clue whether it is attached to the local
// Postgres or to production, and one that dies while connecting never reaches a startup line at
// all. `tryDescribeDbTarget`, not `describeDbTarget`, for the same reason `watchStartupLine` uses
// it: this runs before any validation, so it must not throw over a malformed DATABASE_URL.
console.log(`serve — database ${dbConfig.env} · ${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}`);

// Fail fast, before ever opening a connection. These three throw on their own — a missing/short
// `HERALD_SESSION_SECRET`, an invalid `HERALD_TRUST_PROXY_HOPS`, no dashboard account configured —
// and a misconfigured deploy must learn that from a one-line message, not from `applySchema`'s DDL
// or `assertLedgerMigrated`'s two selects failing against whatever `DATABASE_URL` happens to point
// at. `createDeps` below calls these same three loaders again to build the values it actually
// returns on `ApiDeps` — pure env reads with no side effect beyond throwing, so re-running them is
// harmless — but the ordering here, before `createDb`, is what a misconfigured server actually
// needs: the hosted entry point (Plan C Task 2) gets this from `createDeps` alone, since it never
// owns the moment before `db` exists the way this long-lived process does.
loadSessionConfig();
loadClientIpConfig();
loadAuthConfig();

// One pool for the life of this process — a long-running server, unlike the one-shot CLI commands,
// which each open and close their own.
const db = createDb(dbConfig);
// `applySchema` is idempotent (every statement is `create table if not exists` / `insert ... on
// conflict do nothing`) and cheap, so it runs unconditionally rather than only after a probe. Nothing
// else on this path ever created `auth_attempts` — `db:import`/`db:export` are the only other
// callers, and neither runs before `pnpm serve` on a database Plan A already migrated. Without this,
// the first login attempt against such a database would fail with a raw
// `relation "auth_attempts" does not exist` from `PgAttemptLimiter`, not a message that explains
// anything.
await applySchema(db);
// Refuses to start the dashboard — and therefore ReconcilePublished's scheduler and every
// [발송] click — against a database that looks unmigrated. See assertLedgerMigrated's own doc
// comment for why an empty deliveries table is not, by itself, proof of a fresh install.
await assertLedgerMigrated(db, OUTPUT_DIR);

// The local entry point serves every route, including `[변환 준비]` — see `createDeps.ts` for what
// `routes: "hosted"` (the Vercel entry point, Plan C Task 2) omits and why.
const deps = createDeps({ db, routes: "local" });

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);

// The board's [게시 확인] button stays — this only means an operator who never clicks it still
// sees real x.com links, a couple of minutes after the post goes out.
//
// Guarded: a Telegram-only install has no TYPEFULLY_* env. Every other Typefully-optional path on
// this branch treats that as "nothing to do" (headroomReader returns undefined, doctor uses
// optionalCheck) — without this guard, `reconcilePublished` would report the missing-key error as
// `r.error` on every tick, forever, on an install that is not broken.
try {
  loadTypefullyConfig();
  startReconcileScheduler(deps.reconcilePublished, { log: (m) => console.log(m) });
} catch {
  // Typefully not configured — nothing was ever scheduled through it, so there is nothing to reconcile.
}
