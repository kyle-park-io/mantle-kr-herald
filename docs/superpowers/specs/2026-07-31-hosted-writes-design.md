# Hosted writes — moving the record of truth to Postgres

**Date:** 2026-07-31
**Status:** approved
**Supersedes the open questions in:** `2026-07-29-dashboard-auth-options.md`

## The goal, in one sentence

The team approves 1차/2차 and sends from a URL, not from Kyle's terminal.

Everything below follows from that plus one fact about the platform: **Vercel functions have no
writable disk**, and this app's record of truth is a disk.

## Decisions

Recorded here so the plan does not relitigate them.

| Question | Decision |
|---|---|
| What can the hosted dashboard do? | Everything, including 발송 — live Telegram posts and Typefully→X scheduling |
| Authentication | Shared credential (one account), PR #87 merged and promoted to a real gate |
| Per-user audit trail | Not required. The trade-off was stated and declined |
| Storage | PostgreSQL, single source of truth. Local CLI and Vercel both use it |
| Local-vs-hosted separation | Separate **entry points** and a separate **development database**. NOT separate storage drivers |
| Development database | Empty, test fixtures only. Production data is never copied into it |
| `[변환 준비]` (agent handoff) | Local CLI only. The hosted entry point does not register the route. A request queue is deferred |
| 2-minute reconcile | Stays local (`pnpm send:reconcile` under the operator's cron). Vercel Hobby caps cron at once per day |

### Why not Drive as the record of truth

`HERALD_STORAGE_MODE=cloud` already exists and was the obvious candidate. It is the wrong one.

Drive provides durability but neither atomicity nor locking. The stores are read-modify-write over
whole files, and the two send ledgers depend on `serialWrites.ts` (in-process queue) plus
`fileLock.ts` (cross-process lock) to make that safe. Both layers evaporate on serverless. Moving
to Drive would keep the hazard and add latency — and the hazard is the one `serialWrites.ts`
names: *"a dropped row means a live post the ledger cannot see, which the next run publishes a
second time."* Postgres closes it with a unique index. Drive cannot close it at all.

### Why not a JSON/Postgres driver switch

Two record-of-truth backends means two record-of-truth backends. `translate:save` writing JSON
locally produces a translation the hosted dashboard can never show, so there is nothing to
approve. `src/storage/mode.ts` already states the governing rule for this class of choice —
*"Never inferred... silently choosing 'local' while the operator believes work is backed up is the
one failure this must not allow."*

The legitimate need behind the request — "my local experiments must not reach the team" — is met
by a separate development **database**, not a separate storage **format**.

## What moves

The membership test is: **does the hosted dashboard read or write it?**

### To Postgres

| Today | Why |
|---|---|
| `x/items.json`, `lark/items.json` | `serve.ts` reads these through `CompositeContentSource` to show source text. Without them the hosted board has no 원문 |
| `translations/translations.json` | 1차 edit and approval |
| `variants/variants.json` | 2차 approval flips variant status |
| `formatted/renderings.json` | 2차 edit, approval, `[포맷 다시]` |
| `formatted/overrides.json` | Per-room fork |
| `publish/deliveries.json` (+ legacy `channels.json`) | Send ledger |
| `publish/x-article.json` | X article send ledger |
| `publish/state.json` | Drive sync ledger |
| `lineage/*.jsonl` | Every dashboard save path appends to it |
| `translation/few-shot.json`, `conversion/few-shot.<type>.json` | **Approval writes these.** See below |

The few-shot corpus is not configuration despite living in the config tree.
`SaveTranslation.ts:62` and `ApproveRendering.ts:76` promote an approved pair into it. Leaving it
on disk would make a web approval silently skip corpus promotion — the same button doing two
different things depending on where it was clicked.

### Stays on disk

- `translation/` and `conversion/` guides, glossary, style guide — read only when the local agent converts
- `*/worksheets/`, `*/pending.json` — agent handoff, and `[변환 준비]` is local-only by decision
- `x/runs.json`, `x/state.json` (watermarks) — `collect` is a local job
- `publish/local/`, `archive/`, `x/reference/`

`output/` does not disappear. Review state leaves it; agent working files stay.

### A gap this closes on the way past

`renderings.json` is **not** tracked by `state:push`. `stateFiles.ts` reasons that `format` is
pure code over the variants, so the file regenerates. That is true of the rendering and false of
what else lives in it: `SaveRendering` writes reviewer edits there and `ApproveRendering` writes
approvals there, and `apiHandlers.ts` says so at the `format` route — *"overwrites whatever was
stored (including an edit or an approval)."* Losing the file today loses 2차 review work with no
snapshot behind it.

Moving it into the database puts it inside DB backup and inside `state:push`'s new export. No
separate work; noted so the plan does not treat it as out of scope.

## Schema and concurrency

One table per file, keeping each file's current shape. The constraints carry the design.

`x/items.json` and `lark/items.json` become **two tables, not one**, even though the dashboard
reads both through a single `ContentSource` port that flattens them to `ContentItem`. The raw X
thread shape has consumers the port does not serve — `send-x-article.ts` reads article metadata
off it and `tm-pair.ts` reads whole threads — so collapsing the two at rest would mean
reconstructing a thread from a flattened row.

**`deliveries` has `unique (item_id, type, outlet_id)`.** `deliveryKey()` in
`domain/delivery/models.ts:38` is already exactly this triple. This index becomes the entire
double-post defence.

**Read-modify-write disappears.** Every `upsert()` becomes one `INSERT ... ON CONFLICT DO UPDATE`.
The pattern `serialWrites.ts` warns about — read the file, mutate in memory, write it back — has
no analogue once the mutation is a single statement.

**Deleted:** `src/shared/store/serialWrites.ts`, `src/shared/store/fileLock.ts`, and the wrapping
in `JsonDeliveryLedger` / `JsonXArticleLedger`.

**Resend becomes one transaction.** Today `sendToOutlet.ts` calls `remove(key)` then `add(...)`.
The window between them — the ledger holding no row for a room that was sent to — must not be
observable. The file lock hid it; a transaction removes it.

**`lineage` is append-only with no constraint.** Unbounded growth is unchanged from today.
Partitioning is YAGNI.

## Entry points

`serve.ts` assembles global singletons at module load. Extract that into `createDeps(env)`.
`handleApi(deps, method, path, body)` is already a pure function over its dependencies — that is
what makes this migration tractable, and it is reused unchanged.

- `src/cli/serve.ts` — local. Long-lived process, `[변환 준비]` registered
- `api/[...path].ts` — Vercel. Per-request, `[변환 준비]` **not registered**

The route set is a property of the entry point. On the hosted deployment that button's route does
not exist rather than being hidden in the UI.

`refusalReason()`'s loopback allowlist (`HttpServer.ts`) becomes the deployment origin.

## Authentication

PR #87 lands the credential check. Promoting it to a gate needs three more things.

1. **Issue a session.** `POST /api/login` currently verifies and returns; nothing is issued. Add a
   signed `httpOnly`, `Secure`, `SameSite=Lax` cookie. The auth-options record already argued this
   over JWTs and that conclusion stands.
2. **Consult it.** Every `/api/*` route except login checks the session. Today none do.
3. **Move `AttemptLimiter` to the database.** Its own doc comment says why: *"a serverless
   deployment gets a fresh limiter per instance and would need a shared store to be meaningful."*
   In-memory means the 5-attempt lockout is effectively unlimited across instances. The interface
   exists; only an implementation is needed.

`SameSite=Lax` is the second layer behind the origin check, which matters because
`POST .../send` takes no body and is therefore a simple request — no preflight, so CORS never gets
a say.

**Secrets moving to Vercel env:** `DATABASE_URL`, `HERALD_AUTH_PASSWORD_HASH`, a new session
signing key, `TYPEFULLY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

## Which database, and not guessing which one

`DATABASE_URL` is required; absent, commands refuse rather than falling back. `HERALD_DB_ENV`
(`production` | `development`) is stated explicitly and never inferred from the URL — the rule
`storage/mode.ts` already sets for this class of choice, for the same reason.

Every CLI prints which database it is attached to on its first line, the way `status` and `doctor`
already report mode. The dashboard shows a banner when it is not production.

Provisioning is a marketplace integration (`vercel install neon`), which injects credentials into
the project. The moving set is currently about 500KB, most of it `x/items.json` — well under any
free tier. Serverless connection pooling uses `attachDatabasePool` from `@vercel/functions`.

## Migration and rollback

- **`pnpm db:import`** — the moving set from `output/` into the database. Idempotent.
- **`pnpm db:export`** — database back into the `output/` layout. This is the rollback path and
  must exist before the cutover, not after.
- **`state:push` / `state:pull` stay.** The team already treats a Drive snapshot as the backup, and
  it becomes the recovery path if the database is lost. Only the input changes, from files to a
  database read. `stateFiles.ts`'s judgement about what is unrebuildable remains correct.
- **`doctor`** gains a connectivity check and reports the attached database.

Order: import, verify, then switch the code over. There is no period during which both files and
the database are written — that state is precisely what this design exists to avoid.

## Testing

The existing store tests write real files to real temp directories and mock nothing
(`tests/adapters/store/*`). Keep that.

Postgres stores are tested against a real Postgres via **PGlite** — embedded, no container, real
semantics, a fresh instance per test.

New coverage this design requires:

- The unique constraint rejects a duplicate delivery row. This inherits the job the `fileLock`
  tests do today
- The resend transaction never exposes the intermediate no-row state
- Round trip: `output/` → import → export reproduces the original
- Every write route refuses a request with no session
- The attempt limiter survives across instances

## Deferred, deliberately

- **A request queue for `[변환 준비]`.** Local-only for now; revisit if the team finds it limiting
- **Per-user identity.** Declined for now. Doing it later means adding identity to approval and
  delivery rows, which is additive, not a rewrite
- **Running `collect` on a schedule in the cloud.** It stays a local job
