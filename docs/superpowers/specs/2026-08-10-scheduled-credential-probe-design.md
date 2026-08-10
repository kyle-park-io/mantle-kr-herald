# Scheduled credential probe — catching a death between deploys

`docs/superpowers/specs/2026-08-10-deployed-credential-liveness-design.md` closes with a section
called "What this does not fix":

> The 2026-08-10 incident happened **between** deploys. This change would not have caught it any
> sooner — it catches the next deploy, not the moment of death. Closing that needs the scheduled
> probe named in Scope, and this spec is its prerequisite rather than its replacement.

This is that scheduled probe. The prerequisite shipped the same day, so the remaining work is small:
a thin command, a unit, and a timer, wired onto machinery that already exists and was verified
working on 2026-08-10.

Written 2026-08-10. Every claim below was read out of this repo or measured on this machine.

## The gap this closes

`pnpm deploy:smoke` now fails when a deployed credential is dead — but only when someone deploys.
On 2026-08-10 the deployment's Google, Typefully and Telegram credentials were all answering 401
while `deploy:check` passed 40 ok and the board reported `availableTargets: google — present`. The
credentials had last been known good on 2026-08-06. **Nobody found out for four days**, and then only
because we built a tool that asks.

Nothing runs between deploys that asks.

## Why the probe cannot run locally

Not a preference — the values are unreadable. Vercel stores `GOOGLE_OAUTH_REFRESH_TOKEN` and its
siblings as `--sensitive`, which cannot be read back through the API or the UI. A local check can
only exercise the credentials in the local `.env`, and those are a **different set of objects**: on
2026-08-10 the local copy was green (`pnpm doctor --live`, 21 ok · 0 warn · 0 fail) for four days
while the deployment's copy was dead.

So the only way to learn whether the deployment's credentials work is to make the deployment use
them and report back. That is what `GET /api/diagnostics/live` exists for. This spec adds the thing
that asks on a schedule.

## Scope

One daily check of the **deployment's** credentials, alerting through the Telegram hook the three
scheduled units already use.

Out of scope: the local `.env`'s credentials (`pnpm doctor --live` covers those), surfacing liveness
in the dashboard's env badge, and any coverage while this machine is off.

## Where it runs, and the limit that carries

A local systemd timer triggers it; the probes run inside the deployment.

```
herald-creds.timer  (daily 06:23)
  └─ herald-creds.service
       └─ deploy/herald-run-logged.sh          durable log + exit status passed through
            └─ pnpm creds:check
                 1. log in with HERALD_SMOKE_*        → session cookie
                 2. GET /api/status                   → sendsEnabled
                 3. GET /api/diagnostics/live         → the deployment runs its own seven probes
                 4. checkLiveness(probes, sendsEnabled, httpStatus)
                 5. exit 1 if anything failed
  └─ OnFailure=herald-notify-failure@%n.service       existing hook → Telegram
```

**This does not run while the machine is off.** That was a deliberate choice over a Vercel Cron
alternative, which would run in Vercel's own infrastructure and cover that window. The local timer
was preferred because it reuses machinery already proven here — the wrapper, the failure hook, the
Telegram path — and adds no publicly reachable route, no cron secret, and no
`TELEGRAM_CHAT_ID_OPS` on Vercel. The blind spot it accepts is the same one the whole scheduler
already has: when this box is off, nothing fires and nothing alerts.

## The cost this design accepts

`HERALD_SMOKE_USERNAME` and `HERALD_SMOKE_PASSWORD` must be in `.env`, which means **the dashboard
password itself — not the scrypt hash — sitting in plaintext on this machine**, and in the
deploy-time copy at `~/.herald/app/.env` (mode 600).

`.env.example` already sanctions exactly this use ("in CI, from a deploy script, or unattended") and
in the same block forbids it on Vercel: `deploy:smoke` runs on your machine and knocks on the
deployment as a client, so the deployment has no use for the pair, and a plaintext password in a
deployment's environment is strictly worse than one in a local shell.

There is no way around it within the chosen design: the route is session-gated, and an unattended
caller cannot be prompted.

## Components

### `src/cli/creds-check.ts` — new

The deployment origin comes from `process.argv[2]`, falling back to `HERALD_DEPLOYMENT_ORIGIN`,
which is already set in this machine's `.env`. The unit therefore hardcodes no URL.

**`smokeCredentials`'s `prompt` verdict is a refusal here.** That helper
(`src/cli/smokeCredentials.ts:32-52`) returns three things: `env` when both variables are set,
`refuse` when exactly one is, and `prompt` when neither is. `deploy:smoke` treats `prompt` as "ask
the operator", which is right for a command a human runs. Under a timer it is not: the process would
block on stdin until `TimeoutStartSec` killed it, the unit would exit non-zero, and the operator
would get a Telegram message saying a credential check failed when in fact the check never ran. An
alert that misreports its own cause is worse than no alert. `creds:check` refuses immediately and
says which variables are missing.

### `src/deploy/deploymentSession.ts` — new, and shared

Logging in and carrying the cookie moves here, used by both `creds-check.ts` and
`deploy-smoke.ts`.

This is not tidiness. The 2026-08-10 final review's one Critical finding was that
`deploy-smoke.ts` called `/api/diagnostics/live` **without the session cookie every sibling call
passed** — the route answered 401 on every run and the feature never once executed. Copying that
same login-and-cookie dance into a second CLI is an invitation to repeat it. One copy, two callers.

### `deploy/herald-creds.service` and `.timer` — new

Same shape as the three existing units: `WorkingDirectory=%h/.herald/app`,
`Environment=PATH=%h/.herald/bin:…`, `ExecStart` through `herald-run-logged.sh` with `%n`, and
`OnFailure=herald-notify-failure@%n.service`.

**No `EnvironmentFile=%h/.herald/prod.env`.** This command opens no database. Naming the file would
imply a dependency that does not exist, the same argument `herald-x-reconcile.service` already makes
about not setting `HERALD_OUTPUT_DIR` for a command that touches no output tree. Everything
`creds:check` needs — `HERALD_SMOKE_*`, `HERALD_DEPLOYMENT_ORIGIN` — comes from the frozen `.env`
through its own `tsx --env-file-if-exists=.env`.

`TimeoutStartSec=120`. The route bounds its own probe run at five seconds, and the three HTTP calls
around it are ordinary round trips; 120 s is a generous multiple that still fails long before a
daily cadence could overlap itself.

`OnCalendar=*-*-* 06:23:00`, `Persistent=true`. Once a day, before the working day. The minute avoids
every minute already in use — `:07,:37` (convert), `:17` (watch), `:41` (x-reconcile) — for the
reason `herald-x-reconcile.timer` already gives: units sharing a minute buy nothing and invite two
`pnpm` processes starting at once.

Daily rather than hourly because the failure is rare and slow-moving — the incident this responds to
ran four days — and because a dead credential alerts on **every** fire until it is fixed. Hourly
would mean 24 Telegram messages a day for one problem, which is how an alert channel becomes noise
people stop reading.

## What alerts, and what does not

`checkLiveness` (`src/deploy/smokeChecks.ts:443`) already encodes the severity and is reused
unchanged:

| group | dead ⇒ | alerts? |
| --- | --- | --- |
| publish — `google_auth`, `google_drive_review`, `google_drive_approved`, `lark` | fail | **yes** |
| send — `telegram`, `typefully` | warn while `sendsEnabled` is false, fail when true | only once sends are open |
| data — `google_sheets` | warn | no |
| anything `skipped` | ok | no |

A route that cannot be read — deployment down, 401, 500, malformed body — is a `fail`. Not knowing is
not the same as being fine, and the whole point of this work is to stop treating it as such.

## Failure handling

- A dead credential exits 1, and systemd's `OnFailure=` fires the existing hook. That hook reads
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID_OPS` out of the frozen `.env`
  (`deploy/herald-notify-failure.sh:140-141`) and posts. It is already installed and was confirmed
  wired to all three units on 2026-08-10.
- Missing `HERALD_SMOKE_*` refuses immediately with the names, rather than blocking on a prompt.
- No recovery notification. The hook is `OnFailure` only, and adding a "back to normal" path means
  tracking state between runs for a signal the next morning's silence already carries.

## Testing

- `tests/cli/credsCheck.test.ts` — the real CLI against a stub deployment, following
  `tests/deploy/runLogging.test.ts`'s convention of executing the real thing rather than a stub of
  it: all probes alive → exit 0; a dead publish credential → exit 1; the route answering 401 or 500
  → exit 1; and `HERALD_SMOKE_*` unset → a refusal that **returns**, rather than a process that
  blocks on stdin. That last case is the one a passing test suite would otherwise never notice,
  because a hang looks like a slow test until it looks like a timeout.
- `tests/deploy/credsTiming.test.ts` — the unit and timer as text, the convention the rest of
  `tests/deploy/` uses: `OnFailure=` present, `ExecStart` through `herald-run-logged.sh` with `%n`
  and `%h/.herald/bin/pnpm`, `OnCalendar`'s minute distinct from all three existing timers, and no
  `EnvironmentFile` naming `prod.env`.

## What this still does not fix

The machine being off. If the box is down for a weekend, a credential that dies on Saturday is not
reported until Monday. Closing that means moving the trigger off this machine — the Vercel Cron
option weighed above — and remains available if the blind spot ever costs something.
