# Plan C — Vercel: the team approves and sends from a URL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard runs on Vercel against the production database, with 1차/2차 approval and 발송 working, and `[변환 준비]` absent rather than broken.

**Architecture:** `serve.ts`'s module-level singletons become `createDeps(env)`, shared by two entry points: the long-lived local server and a per-request Vercel function. `handleApi` is reused unchanged. The route set is a property of the entry point, so the agent-handoff route does not exist on the hosted deployment.

**Tech Stack:** Vercel Functions (Node runtime), `@vercel/functions` (`attachDatabasePool`), Neon via the Vercel Marketplace, the `Db` from Plan A and the gate from Plan B.

**Depends on:** Plan A and Plan B, both complete and verified.

**Spec:** `docs/superpowers/specs/2026-07-31-hosted-writes-design.md`

## Global Constraints

- Code and commits in **English**.
- **Irreversible and outward-facing steps are human-supervised.** Provisioning the database, registering secrets, running `db:import` against real data, and the first deploy are performed by Kyle or with explicit confirmation. An agent executing this plan stops and asks at each such step; they are marked 🔒.
- `HERALD_DB_ENV` is stated on every environment, never inferred. Production is `production`; preview deployments are not.
- The hosted entry point **must not register** `POST /api/items/:id/convert-prepare`. Absent, not hidden.
- Vercel Hobby caps cron at once per day, so **no cron job is deployed**. Reconcile stays local.
- Secrets never appear in the repo, in a log line, or in an error body.

---

## Task 1: Extract the composition root

**Files:**
- Create: `src/app/createDeps.ts`
- Modify: `src/cli/serve.ts`
- Test: `tests/app/createDeps.test.ts`

**Interfaces:**
- Consumes: `createStores(db)` (Plan A Task 17), `Db` (Plan A Task 1)
- Produces: `createDeps(input: { db: Db; routes: "local" | "hosted" }): ApiDeps`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../support/testDb";
import { createDeps } from "../../src/app/createDeps";
import { handleApi } from "../../src/adapters/web/apiHandlers";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("createDeps", () => {
  it("builds a dependency set the API can serve from", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "local" });
    const result = await handleApi(authenticated(deps), "GET", "/api/translations", undefined);
    expect(result.status).toBe(200);
  });

  it("registers convert-prepare locally", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "local" });
    const result = await handleApi(authenticated(deps), "POST", "/api/items/x:1/convert-prepare", { types: ["announcement"] });
    expect(result.status).not.toBe(404);
  });

  it("does not register convert-prepare on the hosted route set — the local agent is not there", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "hosted" });
    const result = await handleApi(authenticated(deps), "POST", "/api/items/x:1/convert-prepare", { types: ["announcement"] });
    expect(result.status).toBe(404);
  });

  it("still serves every other write route on the hosted route set", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "hosted" });
    for (const [method, path] of [
      ["POST", "/api/translations/x:1/approve"],
      ["POST", "/api/items/x:1/format"],
      ["POST", "/api/outlets/x:1/announcement/tg-community/send"],
    ] as const) {
      expect((await handleApi(authenticated(deps), method, path, {})).status).not.toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/app/createDeps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Invariants:

- `createDeps` is a **function**, not module-level construction. `serve.ts` currently builds everything at import time; that is what makes it unusable from a request handler.
- The route set is expressed by which dependencies exist: `prepareConversionRun` is `undefined` on the hosted set, and `handleApi` answers 404 when a route's dependency is absent. This puts the rule in one place — read `ApiDeps` in `apiHandlers.ts` and make the optional dependency explicit in the type, so omitting it is a compile-time fact rather than a convention.
- `serve.ts` keeps everything else it does — the reconcile scheduler, static file serving, the local publish reader. Only construction moves.
- Behaviour must not change locally. `pnpm test` covers this; if a test needed editing to pass, something moved that should not have.

- [ ] **Step 4: Green, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add src/app/createDeps.ts src/cli/serve.ts tests/app/createDeps.test.ts src/adapters/web/apiHandlers.ts
git commit -m "refactor(app): extract createDeps so two entry points can share it"
```

---

## Task 2: The Vercel entry point

**Files:**
- Create: `api/[...path].ts`, `vercel.json`
- Test: `tests/adapters/web/vercelHandler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("the Vercel handler", () => {
  it("maps a request onto handleApi and returns its status and body", async () => {
    const res = await invoke(handler, { method: "GET", url: "/api/status", headers: {} });
    expect(res.status).toBe(401); // no session — the gate from Plan B
  });

  it("reads the body only for POST and PUT", async () => {
    const seen: unknown[] = [];
    const res = await invoke(handler, { method: "GET", url: "/api/translations", headers: {} }, seen);
    expect(seen).toEqual([]);
    expect(res.status).toBe(401);
  });

  it("refuses a state-changing request from another origin", async () => {
    const res = await invoke(handler, {
      method: "POST", url: "/api/outlets/x:1/announcement/tg-community/send",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails, then implement**

Invariants:

- The handler is a thin adapter: request → `(method, path, body)` → `handleApi` → response. **No routing, no use-case logic.** Everything it needs already exists.
- It reuses `refusalReason()` from `HttpServer.ts` rather than reimplementing the origin check. Extract that function if it is not already exported — one CSRF rule, not two.
- The origin allowlist is the deployment origin, read from config, not a hardcoded string. Preview deployments have their own origins; a request whose origin is not the one this deployment serves is refused.
- One `Db` per instance via `attachDatabasePool` from `@vercel/functions`, not one per request.
- `vercel.json` builds `web/dist` as static output and routes `/api/*` to the function. **No `crons` key** — Hobby caps at daily and reconcile is local.

- [ ] **Step 3: Green, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add api vercel.json tests/adapters/web/vercelHandler.test.ts src/adapters/web/HttpServer.ts
git commit -m "feat(vercel): serve the API from a function over the shared route table"
```

---

## Task 3: The non-production banner

**Files:** `web/src/components/`, `src/cli/serve.ts`

Plan A Task 18 added `dbEnv` to `StatusView`. Show it.

- [ ] **Step 1: Write the failing test**

```typescript
it("shows a banner when the dashboard is not on the production database", () => {
  render(<Dashboard status={{ ...baseStatus, dbEnv: "development" }} />);
  expect(screen.getByText(/개발/)).toBeInTheDocument();
});

it("shows no banner on production", () => {
  render(<Dashboard status={{ ...baseStatus, dbEnv: "production" }} />);
  expect(screen.queryByText(/개발/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2–4: Red, implement, green**

The banner is persistent and not dismissible — its whole job is to be present when someone is about to approve into the wrong database. Korean copy, matching the dashboard's existing register. Verify in a browser.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck:web && pnpm build:web
git add web/src
git commit -m "feat(web): banner when the dashboard is not on the production database"
```

---

## Task 4: 🔒 Provision the database and register secrets

**Human-supervised. An agent stops here and asks.**

- [ ] **Step 1: 🔒 Provision**

```bash
vercel install neon
```

This provisions the database, connects it to the project, and pulls credentials into `.env.local`.

- [ ] **Step 2: 🔒 Register the remaining secrets**

In the Vercel project, production environment:

| Variable | Source |
|---|---|
| `HERALD_DB_ENV` | `production` |
| `HERALD_SESSION_SECRET` | Newly generated. Not reused from anywhere |
| `HERALD_AUTH_USERNAME`, `HERALD_AUTH_PASSWORD_HASH` | `pnpm auth:hash` |
| `HERALD_STORAGE_MODE` | Existing value |
| `TYPEFULLY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID_*` | Existing `.env` |
| `GOOGLE_OAUTH_CLIENT_ID`, `_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GDRIVE_*` | Existing `.env` |
| `GSHEET_ID`, `GSHEET_QA_ID` | Existing `.env` |

- [ ] **Step 3: Apply the schema**

Run `applySchema` against the production database, and confirm `pnpm doctor` reports it reachable and names it.

---

## Task 5: 🔒 Migrate the real data

**Human-supervised. This is the step that moves live work.**

- [ ] **Step 1: 🔒 Back up first**

```bash
pnpm state:push
```

The Drive snapshot is the pre-migration restore point. Confirm it succeeded and note the folder before continuing.

- [ ] **Step 2: 🔒 Dry run against a scratch database**

Point `DATABASE_URL` at an empty database with `HERALD_DB_ENV=development` and run `pnpm db:import`. Then `pnpm db:export` into a scratch tree and diff it against `output/`:

```bash
diff -r output/ /tmp/herald-export-check/
```

Expected: no differences in the migrated files. **A difference here stops the migration.** Fix the store, not the diff.

- [ ] **Step 3: 🔒 Import into production**

```bash
DATABASE_URL=<production> HERALD_DB_ENV=production pnpm db:import --yes
```

Read the printed per-store counts against `pnpm status` before and after. They must match.

- [ ] **Step 4: 🔒 Verify locally against production**

Point local `.env` at the production database and run `pnpm serve`. Confirm the board shows the same items, translations, renderings and send history as before the migration. **Do not send anything.**

---

## Task 6: 🔒 First deploy

- [ ] **Step 1: 🔒 Deploy to preview first**

```bash
vercel deploy
```

Preview gets its own environment with `HERALD_DB_ENV=development` pointing at a scratch database. **A preview deployment must never hold production send credentials** — omit `TYPEFULLY_API_KEY` and `TELEGRAM_BOT_TOKEN` from the preview environment entirely, so a mistake there cannot reach a live room.

- [ ] **Step 2: Verify on preview**

- Signed out → `#login`
- Wrong password → refusal, and the lockout after five
- Signed in → board loads, source text present
- 1차 edit and approve → reload → persisted
- 2차 edit and approve → reload → persisted
- `[포맷 다시]` re-renders
- `[변환 준비]` **is not present**
- Send button refuses cleanly with no credentials rather than 500ing
- Sign out ends the session
- 1280px and 390px

- [ ] **Step 3: 🔒 Promote to production**

```bash
vercel deploy --prod
```

- [ ] **Step 4: 🔒 One real send, watched**

The Typefully publishing quota is **15/month** and is the real ceiling — never test with a throwaway send. Wait for a genuine deliverable, send it from the hosted board, and confirm: the room received it, the ledger row appeared, and `pnpm send:reconcile` locally resolves the x.com URL onto the same row.

- [ ] **Step 5: Retire the local-only path**

Once production is trusted, `output/` review state is dead weight and a second copy someone could mistake for current. Archive it (`pnpm archive`) rather than deleting — `db:export` regenerates it if the rollback is ever needed.

---

## Rollback

At any point after Task 5:

```bash
pnpm db:export          # database → output/
# revert to the pre-Plan-A commit
pnpm serve              # runs on files again
```

`state:pull` restores the pre-migration Drive snapshot if the export itself is in doubt.

---

## Done when

- The team can sign in, approve 1차 and 2차, and send from the URL
- `[변환 준비]` returns 404 on the hosted deployment and works locally
- No cron job is deployed; `pnpm send:reconcile` runs locally and its results appear on the hosted board
- A preview deployment cannot reach a live room
- The rollback above has been walked through at least once on the scratch database

**Deferred by decision:** a request queue for `[변환 준비]`, per-user identity, cloud `collect`.
