import "./registerErrorHandler";
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import { createDb } from "../adapters/db/createDb";
import { applySchema } from "../adapters/db/schema";
import { assertLedgerMigrated } from "./assertLedgerMigrated";
import { startReconcileScheduler } from "./reconcileScheduler";
import { loadDbConfig, loadTypefullyConfig } from "../config";
import { REPO_ROOT, OUTPUT_DIR, paths } from "../paths";
import { createDeps } from "../app/createDeps";

const port = Number(process.env.PORT) || 5757;
const dbConfig = loadDbConfig();

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
