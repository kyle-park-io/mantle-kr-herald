# Deploy scripts — checking before, observing after

Two commands around the one manual step, so the Vercel deployment stops depending on an operator
remembering a checklist. `pnpm deploy:check` refuses a deploy that would land wrong;
`pnpm deploy:smoke <url>` proves the one that landed is actually right.

Written 2026-08-04, after a full local rehearsal of the three run profiles. Every requirement below
comes from a failure that rehearsal actually produced, not from imagining what could go wrong.

## The goal, in one sentence

Turn DEPLOY.md's §0 and §5-3 checklists into commands, and make the deploy button the only thing a
human has to get right.

## What each command owns

| | Looks at | When |
|---|---|---|
| `pnpm doctor --live` (exists) | the local `.env` | any time |
| `pnpm deploy:check` (new) | the Vercel **project** | before deploying |
| `pnpm deploy:smoke <url>` (new) | the **running deployment** | after deploying |

Three different subjects. `doctor` answers "are my laptop's credentials good", `deploy:check`
answers "is the Vercel project configured", `deploy:smoke` answers "does the thing that is now
serving the team behave correctly".

**The deploy itself stays manual.** Chaining check → deploy → smoke into one command would make the
deploy a side effect of a script that mostly prints green ticks, and this deploy changes the screen
the whole team works from. The two halves can be chained later if that ever stops being true; the
reverse is harder.

## The gap neither command closes

**Neither can tell whether the deployment's Google refresh token is alive.**

`deploy:check` does not read Vercel's values: `--sensitive` variables cannot be read back at all,
and reading the rest means `vercel env pull` writing production secrets to disk. `deploy:smoke`
cannot see it either, because the application only checks *presence* — `createDeps` probes the
Google config in a try/catch and drops the target when it throws, so a revoked token still leaves
`availableTargets` containing `google`. That is exactly the state the 2026-08-04 rehearsal ran in
for an hour: `doctor` reported `✓ Google Drive configured` while every refresh returned
`invalid_grant`.

Closing it properly means a liveness probe in the app, which is a separate change. What these
scripts do instead: `deploy:check` verifies the **local** token is alive and states plainly that it
cannot verify Vercel's copy, so rotating the token is understood as a two-place edit. The failure
mode is documented rather than papered over.

## `pnpm deploy:check`

### The working tree is what ships

`vercel deploy --prod` uploads the local directory, not a commit. That single fact makes these
checks substantive rather than ceremonial:

- on `main`, working tree clean, in sync with `origin/main`
- `pnpm test` passes — **local** tests, because local files are what get uploaded. CI's run on the
  merge commit says nothing about the directory being deployed. `--skip-tests` exists for the
  iterations where you are fixing a Vercel variable and re-running, and it prints that it skipped.

### The Vercel project

Read through `vercel env ls` and `vercel api`; no secret value is ever fetched.

- Every variable that makes the function **refuse to start** is registered: `DATABASE_URL`,
  `HERALD_DB_ENV`, `HERALD_STORAGE_MODE`, `HERALD_AUTH_USERNAME`, `HERALD_AUTH_PASSWORD_HASH`,
  `HERALD_SESSION_SECRET`, `HERALD_TRUST_PROXY`, `HERALD_DEPLOYMENT_ORIGIN`.
- Every variable that **degrades in silence** is registered: `GOOGLE_AUTH_MODE`,
  `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`, `GDRIVE_REVIEW_FOLDER_ID`,
  `GDRIVE_APPROVED_FOLDER_ID`, `GDRIVE_SENT_FOLDER_ID`, `LARK_APP_ID`, `LARK_APP_SECRET`,
  `LARK_WORKSPACE_URL`, `LARK_DRIVE_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID_*`,
  `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, `X_PREMIUM`, `GSHEET_ID`, `GSHEET_QA_ID`.
  Missing ones are warnings, not errors — a Telegram-only install is legitimate — but each names
  what stops working.
- `HERALD_SENDS_ENABLED` is **absent**. Present on a first deploy is a warning; the hosted board is
  meant to ship with sends closed.
- `GOOGLE_SA_KEY_FILE` is **absent**. It is a local path; the function has no such file. Present is
  an error.
- `vercel.json`'s `regions` matches the project's `serverlessFunctionRegion`.
- The project's real domain is printed, with the statement that `HERALD_DEPLOYMENT_ORIGIN` must
  equal it. The value cannot be compared here — `deploy:smoke` proves it instead (below).

### Local credentials are alive

**Spawns `pnpm doctor --live` and requires exit 0** — `doctor.ts` already sets `process.exitCode = 1`
when any check fails, and already prints a report worth reading. Neither importing its check
functions nor restating them here: a second copy of "what counts as configured" is exactly the kind
of duplicate that drifts. `deploy:check` adds the Vercel-side checks doctor does not make and
delegates the rest.

## `pnpm deploy:smoke <url>`

### Before logging in

- `GET /` serves the SPA
- `GET /api/status` → **401**
- `POST /api/login` with a foreign `Origin` → **403**
- an unknown path → the SPA, not an error

### Logging in

The password is read from a prompt, never an argument — the same rule and the same helper
(`src/cli/prompt.ts`) `pnpm auth:hash` uses, so it stays out of shell history and process listings.

**A 403 here means `HERALD_DEPLOYMENT_ORIGIN` is wrong**, and the output says so in those words.
This is how the value `deploy:check` could not read gets verified: by the CSRF guard either
accepting this deployment's own origin or not.

### After logging in

`/api/status` must report:

- `storageMode === "cloud"` — `local` writes approved documents to an ephemeral filesystem
- `dbEnv === "production"`
- `sendsEnabled === false` — first deploy ships closed
- `conversionEnabled === false` — the hosted route set has no local agent
- `availableTargets` contains `google`; absent means §3 credentials are missing
- every `integrations` entry `configured`

And `POST /api/items/:id/convert-prepare` → **404**, so the route is genuinely absent rather than
merely rejecting.

Then logout clears the session and `/api/status` returns 401 again.

### What it does not do

**It never sends.** No outlet route is called.

**The per-IP lockout check is opt-in, behind `--lockout`.** Five failed logins lock that address for
sixty seconds, and running it by default would lock the operator out of the production dashboard
while the team may be using it.

## Testing

The judgement is separated from the transport: pure functions take a parsed response and the
expected shape and return pass/fail with a reason, and the network layer stays thin enough to read.
Unit tests drive the pure half with fabricated responses, including every failure the rehearsal
produced — `storageMode: "local"`, a missing `google` target, `sendsEnabled: true`, a 403 on login.

Same shape as `readStatic` (`src/cli/staticFiles.ts`), for the same reason: the interesting
behaviour becomes testable without standing anything up.

## Deferred, deliberately

- **Chaining into one `deploy:prod`.** See "What each command owns".
- **A liveness probe endpoint** so a dead Google token is visible without publishing something. This
  is the real fix for the gap above, and it is an application change, not a script.
- **CI use.** The prompt-based password rules out unattended runs. If that is ever needed, an
  environment variable can be added alongside the prompt; the reverse — starting with the variable —
  would put the production password in a shell history for no current benefit.
