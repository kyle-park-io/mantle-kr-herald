# Deployed credential liveness — the separate change 2026-08-04 deferred

`docs/superpowers/specs/2026-08-04-deploy-scripts-design.md:44` ends its "The gap neither command
closes" section with a promise:

> Closing it properly means a liveness probe in the app, which is a separate change.

This is that change. Nothing knows whether the deployment's Google refresh token is alive, and the
gap has now produced two incidents rather than one.

Written 2026-08-10. Every claim below was read out of this repo or measured against the running
deployment on that date, with file and line.

## The two incidents

**2026-08-04.** A rehearsal ran for an hour with `pnpm doctor` reporting `✓ Google Drive configured`
while every refresh returned `invalid_grant`. Recorded in the deploy-scripts spec.

**2026-08-10.** Revoking a leaked refresh token also revoked the grant, so the deployment's own copy
died with it. `pnpm deploy:check` passed (40 ok · 1 warn · 0 fail). `pnpm deploy:smoke` passed
(21 ok · 2 warn · 0 fail) and reported `availableTargets: google — present`. Both were correct and
both were useless: the token behind that `present` had been dead for minutes. The failure was found
only because we had caused it.

## Why neither command can see it

Not an oversight in either one — it is structural, in three places.

**The deployment reports presence, by construction.** `src/app/createDeps.ts:244` says so in its own
comment:

```ts
/** Credential presence per integration (env only, no live calls) — for the dashboard's env panel. */
```

Every entry is `configured: probe(loadSomeConfig)` (`createDeps.ts:255-280`) — true when the loader
does not throw. `availableTargets` is built the same way, from a try/catch around config loading
(`createDeps.ts:225-242`). A revoked token loads exactly like a live one.

**`deploy:check` cannot read the value.** It reads variable *names* from `vercel env ls production
--json` and nothing else (`src/deploy/requirements.ts`, `src/cli/deploy-check.ts:138-156`).
`--sensitive` variables cannot be read back at all, and reading the rest would mean writing
production secrets to disk. It already says so on screen, in the warn line at
`deploy-check.ts:265-271`.

**`deploy:smoke` reads the deployment's own report**, which is the presence report above.

So liveness is observable from exactly one place: **inside the deployment**, where the credential
is. It has to be probed there and asked for from outside.

## Scope

Deploy-time verification only. A dead credential should be caught by the command already run at
every deploy, in the same pass that already logs in and reads `/api/status`.

Deliberately out of scope, and each gets its own footing once this exists: a scheduled probe that
alerts when a credential dies *between* deploys (which is the shape of the 2026-08-10 incident), and
surfacing liveness in the dashboard's own env badge.

## Architecture

```
deploy:smoke ──POST /api/login─────────────▶ session
             ──GET /api/diagnostics/live───▶ deployment runs the probes
                                                   │  Google · Lark · Typefully · Telegram
             ◀── [{ key, status, detail }] ────────┘
             → checkLiveness() maps each to ok / warn / fail
```

**A new route, not a field on `/api/status`.** The dashboard calls `/api/status` on every load, and
`createDeps.ts:244`'s "env only, no live calls" is a property worth keeping rather than an accident.
Six external calls on every board render would be a different bug.

## Components

### `src/doctor/liveProbes.ts` — new, and shared

The probes already exist, inline in `src/cli/doctor.ts`'s `if (live)` block (`doctor.ts:131-176`).
They move here as functions over already-loaded config and an injected `fetch`, returning
`LiveProbeResult[]`.

```ts
export type ProbeStatus = "ok" | "dead" | "skipped";
export interface LiveProbeResult {
  key: string;              // matches IntegrationStatus.key
  status: ProbeStatus;
  detail: string;           // never contains a credential
}
```

Both `pnpm doctor --live` and the new route call this. Extracting rather than reimplementing is the
point: a second copy of "is this token alive" would drift from the first, and the drifted one would
be the one running in production.

| key | probe | notes |
| --- | --- | --- |
| `google_auth` | refresh the token | the one that died twice |
| `google_drive` | GET the review and approved folder ids | a live token still fails on a stale folder id |
| `google_sheets` | GET the spreadsheet | needs the `spreadsheets` scope; see 2026-08-10's own 404 |
| `lark` | fetch a tenant access token | |
| `typefully` | GET the social set | yields remaining quota as a side effect |
| `telegram` | `getMe` | validates the bot token; sends nothing |

`twitterapi` is **not** probed. The deployment never collects and its key is deliberately absent
(`docs/ko/setup/vercel.md` §4); probing it would manufacture a failure out of a correct setup.

### `GET /api/diagnostics/live`

Behind the session, like every route but `POST /api/login`. Runs the probes in parallel and answers
**200 with the report even when every probe fails** — the endpoint reports, the caller judges. On
both route sets (`local` and `hosted`): local costs nothing and means `pnpm serve` exercises the
same route in development.

### `checkLiveness()` in `src/deploy/smokeChecks.ts`

Maps the report onto the existing `CheckResult` shape, beside the checks already there.

## Severity

| group | probes | dead ⇒ |
| --- | --- | --- |
| publish | `google_auth`, `google_drive`, `lark` | **fail** |
| send | `telegram`, `typefully` | **warn** while `sendsEnabled` is false, **fail** when true |
| data | `google_sheets` | **warn** — header links only |

Publishing fails because reviewing, approving and publishing is what this deployment is for. Sends
follow the flag the deployment already reports in the same payload, so the check tightens exactly
when sends open rather than on a second, separately-remembered decision.

**Liveness only judges what is configured.** An unconfigured integration probes as `skipped` and is
neither fail nor warn — presence is `deploy:check`'s job, and a Telegram-only install must not go
red because Lark Drive is absent. This mirrors the `fail`/`warn` split `requirements.ts:21-27`
already draws for the same reason — "a Telegram-only install with no Google Drive credentials is a
legitimate deployment, not a broken one".

## Error handling and cost

- Each probe gets a 5-second timeout and they run in parallel, so the route answers in about five
  seconds even when an external API is hanging.
- A probe that throws becomes `status: "dead"` with the error's message. The route never 500s on a
  probe failure — a diagnostic endpoint that dies when something is wrong is no diagnostic.
- **No probe's `detail` may contain a credential.** This is the load-bearing property: the route
  holds every live secret the deployment has, and its output crosses the network to a terminal and
  into CI logs. Pinned by test, not by review.
- No caching. The dashboard does not call this route, so normal usage is once per deploy.

## Testing

- `tests/doctor/liveProbes.test.ts` — each probe against an injected fetch: 200 → `ok`, 401/400 →
  `dead` carrying the status, a thrown network error → `dead` rather than a propagated throw, absent
  config → `skipped`. Plus the one that matters: a secret-shaped value handed to every probe never
  appears in any `detail`.
- `tests/adapters/web/diagnosticsRoute.test.ts` — 200 with a full report when every probe fails; 401
  for an anonymous caller; present on both route sets.
- `tests/deploy/smokeChecks.test.ts` — extended for the mapping: each group's severity, the
  `sendsEnabled` flip, and `skipped` counting as neither fail nor warn.

## What this does not fix

The 2026-08-10 incident happened **between** deploys. This change would not have caught it any
sooner — it catches the next deploy, not the moment of death. Closing that needs the scheduled probe
named in Scope, and this spec is its prerequisite rather than its replacement.
