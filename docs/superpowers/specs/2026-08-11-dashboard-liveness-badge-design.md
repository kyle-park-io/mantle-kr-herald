# Liveness in the env badge — the last thing the 2026-08-10 pair deferred

Two specs written on 2026-08-10 close with the same sentence. `2026-08-10-deployed-credential-liveness-design.md`, under Scope:

> Deliberately out of scope, and each gets its own footing once this exists: a scheduled probe that
> alerts when a credential dies *between* deploys (which is the shape of the 2026-08-10 incident), and
> **surfacing liveness in the dashboard's own env badge**.

`2026-08-10-scheduled-credential-probe-design.md` repeats it under Out of scope. The scheduled probe
shipped the same day (`deploy/herald-creds.timer`, daily 06:23). This is the other half.

Written 2026-08-11. Every claim below was read out of this repo.

## The gap this closes

The dashboard header's `local`/`cloud` badge already opens a card listing every integration and
whether it is `설정됨` or `키 없음` (`web/src/App.tsx:198-258`). That card answers a question nobody
was hurt by: **whether a key is present**. `src/app/createDeps.ts:245` says so in its own comment —
*"Credential presence per integration (env only, no live calls)"*.

Presence is exactly what was green throughout the 2026-08-10 incident. `deploy:check` passed 40 ok,
the board reported `availableTargets: google — present`, and Google, Typefully and Telegram were all
answering 401 on the deployment. The screen the team actually looks at said nothing, for four days.

`GET /api/diagnostics/live` now knows the truth, and three callers ask it: `deploy:smoke` at every
deploy, `pnpm creds:check` daily, and nobody else. **The board never asks, and cannot show what the
others learned** — a probe result today lives only in a terminal and a systemd journal that this
machine rotates every eight minutes.

## Scope

The header badge shows the deployment's last observed credential liveness, and offers to re-check.

Out of scope: probing on page load (below), a liveness history or trend, per-integration retry from
the UI, and anything about the local `.env`'s credentials on a hosted board — `pnpm doctor --live`
owns those, and they are a different set of objects.

## Why the board cannot simply ask

`/api/diagnostics/live` costs roughly eleven outbound requests under a five-second whole-run deadline
(`src/doctor/liveProbes.ts:116`, `:507`). `web/src/App.tsx:65-76` calls `/api/status` on mount, on
every login, and after each of the five 1차 mutations. Wiring the probes into that path would put
eleven external calls behind an approve button. `src/adapters/web/apiHandlers.ts:312-314` already
refuses this in writing:

> Deliberately NOT a field on `/api/status`: the dashboard calls that on every load, and
> `createDeps`'s "env only, no live calls" is a property worth keeping rather than an accident. Six
> external calls per board render would be a different bug.

That constraint stands. What follows keeps it.

## The shape this repo already has for this problem

`translate_floor_reports` (`src/adapters/db/schema.ts:295`) solves the identical problem one axis
over. The translation floor lives in a systemd unit; a Vercel function has no systemd; so the
scheduler **reports what it ran with** into one row, and the hosted dashboard reads that row and says
how old it is. `PgTranslateFloorReport`'s header states the rule this design inherits: *"this row is
an observation of that unit, never an input to anything."*

Liveness is the same shape. The probes can only run inside the deployment; the board renders later;
what a reader needs is the latest observation and its age.

## Architecture

```
creds:check (daily 06:23) ─┐
deploy:smoke (each deploy) ─┼─▶ GET /api/diagnostics/live ─▶ runLiveProbes()  ─▶ 7 results
[지금 확인] button ─────────┘                                      │
                                                                   ▼
                                                        credential_liveness (1 row, upsert)
                                                                   │
web board (every load) ─────▶ GET /api/status ─────────────────────┘
                                    │  reads the row, grades it, ships a summary
                                    ▼
                              badge + ⚠ chip + hover card
```

**The route is the only writer.** Not `creds:check`, and this matters: that command talks to the
deployment over HTTP precisely because the deployment's credentials are unreadable from outside
(`--sensitive` values cannot be read back). A CLI that reached into production Postgres to record
what it learned over HTTP would re-open the coupling the HTTP call exists to avoid, and would write
with whatever `DATABASE_URL` the operator's `.env` happens to hold. The deployment records what the
deployment observed, one line after observing it.

Because the route is the writer, every existing caller populates the row for free. No new scheduled
unit, no new command, no change to `deploy/herald-creds.service`.

**`pnpm doctor --live` does not write.** It calls `runLiveProbes` directly (`src/doctor/`), never the
route, so a local probe of the local `.env` cannot land in a row that claims to describe the
deployment. Worth a test rather than a comment.

**Running `pnpm serve` locally writes to the local database about the local credentials.** That is
consistent — the row means "what this instance observed about the credentials it runs with" — and
`dbEnv` already tells the two apart on screen.

## The table

```sql
create table if not exists credential_liveness (
  id text primary key,          -- 'singleton', same spelling as auth_attempts / translate_floor_reports
  probes text not null,         -- JSON: [{ key, status, detail }]
  observed_at text not null
)
```

One row, upserted, for the reason `PgTranslateFloorReport` gives for its own: a history of every
probe run would be a second event log beside `lineage`, growing daily, answering a question nobody
asks. The latest observation and its age is the whole requirement.

`probes` stores `key`, `status` and `detail` for all seven — not `grantedScopes`, `quota`,
`httpStatus` or `resourceName`, which serve `deploy:smoke`'s terminal output and have no reader here.
`detail` is kept because the distinction it carries is the one that mattered on 2026-08-10: `400
invalid_grant` means the token is dead, `401` means the client credentials do not match, and
re-minting on a 401 loops forever (`docs/ko/deploy.md:133-150`). A card that said only "Google is
dead" would send its reader down the wrong path.

Storing `detail` is safe by construction, not by care: every string leaf of every result is redacted
inside `liveProbes.ts` before it leaves the module, on the return path as well as on throw
(`liveProbes.ts:156-165`, `:211-236`), against a secret set that includes the two tokens obtained
mid-run. This is the same string already crossing the network to a terminal and a CI log.

`observed_at` is never null — an observation with no age would put us back to stating a status as
though it had just been checked.

## Grading, in one place

`PROBE_TIER` and `liveSeverity` (`src/deploy/smokeChecks.ts:377-409`) already encode the policy:
publishing credential ⇒ `fail`, send credential ⇒ `sendsEnabled ? fail : warn`, Sheet ⇒ `warn`,
unknown key ⇒ `fail`. `skipped` and `ok` both grade ok, because presence is `deploy:check`'s job and a
Telegram-only install must not go red over an absent Lark.

**Move `PROBE_TIER`/`liveSeverity` to `src/doctor/liveSeverity.ts`**, beside the `ProbeKey` they are
keyed on, and have `smokeChecks.ts` import them. The layering is the argument: `src/doctor` owns the
probes, and both consumers — `src/deploy` for a terminal, `src/adapters/web` for a request — are
downstream of it. A web adapter importing out of `src/deploy` to grade a request would be the wrong
direction, and duplicating the table would put the drifted copy in production, which is the exact
failure `liveProbes.ts` was extracted to prevent.

`checkLiveness()` keeps its CLI-shaped `CheckResult[]` output and its extra guards (short report,
non-array, missing payload). Two renderings, one policy table.

**The server grades; the web renders.** `web/src/collectedBreakdown.ts` states why in its header:
*"Nothing is re-derived on this side — a card that did its own arithmetic is exactly how the CLI and
the header drifted apart the last time."* The web cannot import the domain anyway
(`tests/web/typeMirror.test.ts:53-58`), so a severity rule copied into `web/src` would be a second
policy nothing pins.

## What `/api/status` carries

A new optional field on `StatusView` (`src/adapters/web/apiHandlers.ts:37-64`) and its hand-written
mirror in `web/src/types.ts`:

```ts
interface LivenessSummary {
  observedAt: string;                 // ISO, for the age line
  worst: "ok" | "warn" | "fail";      // the chip's colour, already graded
  dead: { key: ProbeKey; severity: "warn" | "fail"; detail: string }[];  // empty when all ok
  total: number;                      // probes in the observation, for "7개 모두 응답"
}
```

Optional, like `dbEnv`/`sendsEnabled` before it: an older cached bundle renders nothing rather than
guessing. Absent means *no observation has ever been recorded* — a database predating this feature, or
an install that has never deployed or run the daily unit — and reads as today's screen.

Cost: one indexed single-row lookup beside the seven `loadStatus` already does — five in one
`Promise.all`, the collection repository, and the floor report — and **it degrades to absent rather
than taking `/api/status` down**. `createDeps.ts:174` already carries this exact reasoning for the
floor report: the hosted deployment is the one reader that does not apply the schema
at startup, so between a Vercel deploy and the next `pnpm db:migrate` there is a window where this
code talks to a database without the table. The status route must survive it.

## The screen

The pill itself is untouched — it encodes storage mode, and mode and health are two facts that must
not share one colour. A chip appears **beside** it, only when there is something to say:

| Observation | Chip |
|---|---|
| all seven ok | none — the header is byte-identical to today's |
| a publishing credential dead (Google auth, either Drive folder, Lark) | red `⚠ 발행 키 1개 응답 없음` |
| a send credential dead, sends open | red `⚠ 발송 키 1개 응답 없음` |
| a send credential dead, sends closed | amber, same text |
| Sheet only | amber `⚠ 시트 응답 없음` |
| observation older than 26h | amber `⚠ 확인 26시간 전` |
| no observation ever | none |

Red for a hard failure, amber for attention, `⚠ ` as the inline-warning prefix — the conventions
already practiced across `OutletCard.tsx`, `OutletBoard.tsx` and `CollectedBreakdownCard.tsx`.

The hover card keeps its `설정됨`/`키 없음` list and gains one section under it: `살아있음 · N시간 전
확인` with the dot idiom the card already uses, a line per dead probe naming it and its `detail`, and
a `[지금 확인]` button. The button calls `/api/diagnostics/live`, renders the returned report, and
needs no second call — the route has already written the row, so the next load agrees with what the
operator just saw. Pending state is `확인 중…`, matching `LoginPage.tsx:133`.

**Staleness is a real signal, not pedantry.** `deploy/herald-creds.timer` fires daily at 06:23, so a
healthy observation is at most 24 hours old plus the run. 26 hours is one missed fire plus margin,
derived from the cadence the way `REPORT_STALE_AFTER_MS` is derived from
`herald-watch.timer` (`web/src/collectedBreakdown.ts:25-32`). A missed fire is worth surfacing here
because the unit's own `OnFailure=` hook cannot cover the case that matters: when this machine is
simply off, nothing fails, no Telegram arrives, and the board is the only place the silence shows.

Stale and dead are different states and must read differently — amber and a time, versus red and a
key name. A stale observation is not evidence that anything is wrong; it is evidence that nothing has
looked.

## Error handling

- The upsert is best-effort and never fails the route. `/api/diagnostics/live` exists to answer when
  things are broken; a diagnostic that 500s because it could not record its own answer is the same
  mistake as one that 500s because a probe failed, which `tests/adapters/web/diagnosticsRoute.test.ts`
  already pins against.
- A malformed or unparseable `probes` column reads as no observation, not as a failure.
- The status read is wrapped exactly as the floor report's is, for the unmigrated-database window.
- The button surfaces a failed call as an inline message in the card and leaves the stored observation
  on screen — the last known truth is more useful than a blank.

## Testing

- `src/doctor/liveSeverity.ts` — the tier table and `liveSeverity`, moved with their existing tests.
- The route writes what it observed, and a write that throws still returns 200 with the probes.
- `pnpm doctor --live` writes nothing.
- `loadStatus` grades a stored observation: one per severity tier, `sendsEnabled` both ways, stale,
  absent, malformed.
- `tests/support/fakeApiDeps.ts:84`'s `loadStatus` literal widens; `tests/web/typeMirror.test.ts`
  pins the new mirror and any new label constants.
- `web/tests/App.test.tsx`'s `stubFetch` throws on an unrecognised URL, so the `지금 확인` path adds
  `/api/diagnostics/live` to each stub — chip absent when all ok, red on a dead publishing key, amber
  on a stale observation, and the button's pending/failed states.
- `tests/adapters/web/gate.test.ts` needs no change: no new route.

## What this does not fix

The board shows what was last observed, and the daily unit only runs when this machine is on. A
credential that dies at 07:00 is invisible until 06:23 the next morning — the same window the
scheduled probe already accepted, now visible on screen instead of only in a Telegram message. Closing
it needs a probe that runs somewhere always on, which is a different spec, and Vercel Hobby's one-cron
-a-day ceiling is why it is not this one.
