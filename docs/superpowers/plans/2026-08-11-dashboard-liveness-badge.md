# Dashboard liveness badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard header shows whether the deployment's credentials still WORK — not merely that keys are present — out of the last observation any caller of `GET /api/diagnostics/live` recorded, with a button to take a fresh one.

**Architecture:** The route's own dep records what it just probed into one upserted Postgres row (`credential_liveness`), exactly as the watch tick records its floor into `translate_floor_reports`. `GET /api/status` reads that row, grades it server-side with the severity policy `deploy:smoke` already uses, and ships a small summary. The web renders the summary and re-derives nothing.

**Tech Stack:** TypeScript, Node 24, Postgres (`pg`), Vitest, React 19 + Vite + Tailwind (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-11-dashboard-liveness-badge-design.md`

## Global Constraints

- Code, comments, commit messages and `CHANGELOG.md` in **English**; `docs/ko/` and every user-facing dashboard string in **Korean**.
- **The dashboard cannot import the domain.** `web/tsconfig.json` includes only `web/`, so any shared type or string is hand-mirrored in `web/src/types.ts` and pinned in `tests/web/typeMirror.test.ts`.
- **Nothing is re-derived on the web side** (`web/src/collectedBreakdown.ts` header). Severity, tiers and counts are computed on the server; the web maps them to Korean and to colours.
- `/api/status` must stay **"env only, no live calls"** (`src/app/createDeps.ts:245`, `src/adapters/web/apiHandlers.ts:312`). This plan adds one single-row DB read and zero outbound requests to that path.
- Every commit must leave `pnpm test`, `pnpm typecheck` and `pnpm typecheck:web` green.
- Postgres tests use `createTestDb()` from `tests/support/testDb`, and every test that opens one closes it in `afterEach`.
- Colour register, already practiced repo-wide: **red** = hard failure, **amber** = attention, `⚠ ` prefixes an inline warning, mint = healthy.

---

### Task 1: Move the severity policy out of `src/deploy`

The web adapter must grade a request, and a web adapter reaching into `src/deploy` to do it is the wrong direction. `src/doctor` owns the probes; both consumers sit downstream of it.

**Files:**
- Create: `src/doctor/liveSeverity.ts`
- Modify: `src/deploy/smokeChecks.ts` (delete `ProbeTier`, `PROBE_TIER`, `liveSeverity`, `EXPECTED_PROBE_KEYS`; import them instead)
- Test: `tests/doctor/liveSeverity.test.ts`

**Interfaces:**
- Consumes: `ProbeKey` from `src/doctor/liveProbes.ts`.
- Produces: `type ProbeTier = "publish" | "send" | "data"`, `type Severity = "ok" | "warn" | "fail"`, `PROBE_TIER: Record<ProbeKey, ProbeTier>`, `liveSeverity(key: ProbeKey, sendsEnabled: boolean): Severity`, `EXPECTED_PROBE_KEYS: ProbeKey[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/doctor/liveSeverity.test.ts
//
// The one severity policy, now that two callers read it: `deploy:smoke`/`creds:check` render it as
// terminal lines, and `/api/status` renders it as a chip on the board. A second copy would put the
// drifted one in whichever surface nobody was looking at.
import { describe, it, expect } from "vitest";
import { PROBE_TIER, EXPECTED_PROBE_KEYS, liveSeverity } from "../../src/doctor/liveSeverity";

describe("liveSeverity", () => {
  it("fails on a dead publishing credential regardless of whether sends are open", () => {
    for (const key of ["google_auth", "google_drive_review", "google_drive_approved", "lark"] as const) {
      expect(liveSeverity(key, true)).toBe("fail");
      expect(liveSeverity(key, false)).toBe("fail");
    }
  });

  it("follows sendsEnabled for a dead send credential", () => {
    expect(liveSeverity("telegram", true)).toBe("fail");
    expect(liveSeverity("telegram", false)).toBe("warn");
    expect(liveSeverity("typefully", true)).toBe("fail");
    expect(liveSeverity("typefully", false)).toBe("warn");
  });

  it("only ever warns about the Sheet — it is header links, not a publishing path", () => {
    expect(liveSeverity("google_sheets", true)).toBe("warn");
    expect(liveSeverity("google_sheets", false)).toBe("warn");
  });

  it("grades an unknown key as fail, because not knowing which tier a credential is in is not a pass", () => {
    expect(liveSeverity("something_new" as never, true)).toBe("fail");
  });

  it("derives the expected key list from the tier table rather than restating it", () => {
    expect(EXPECTED_PROBE_KEYS).toEqual(Object.keys(PROBE_TIER));
    expect(EXPECTED_PROBE_KEYS).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/doctor/liveSeverity.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/liveSeverity"`.

- [ ] **Step 3: Create the module, moving the code verbatim**

Move the four declarations out of `src/deploy/smokeChecks.ts` **with their existing doc comments** — they carry the reasoning (`PROBE_TIER`'s "unknown is not-known" argument, `EXPECTED_PROBE_KEYS`' compile-time exhaustiveness note) and re-typing them would lose it.

```ts
// src/doctor/liveSeverity.ts
import type { ProbeKey } from "./liveProbes";

/**
 * What a credential is FOR, which is what decides how loud its death is — not which API answered.
 * Lives beside `ProbeKey` rather than in `src/deploy`, because both consumers are downstream of the
 * probes: `src/deploy/smokeChecks.ts` renders this as terminal lines for `deploy:smoke`/`creds:check`,
 * and `src/status/liveness.ts` renders it as a chip on the board. A web adapter importing out of
 * `src/deploy` to grade a request would be the wrong direction, and a second copy of the table would
 * put the drifted one in production.
 */
export type ProbeTier = "publish" | "send" | "data";

/** The three gradings a dead credential can carry. Identical to `CheckResult["status"]`, which is
 *  what `smokeChecks.ts` still assigns it to. */
export type Severity = "ok" | "warn" | "fail";

export const PROBE_TIER: Record<ProbeKey, ProbeTier> = {
  google_auth: "publish",
  google_drive_review: "publish",
  google_drive_approved: "publish",
  lark: "publish",
  typefully: "send",
  telegram: "send",
  google_sheets: "data",
};

// … `liveSeverity` and `EXPECTED_PROBE_KEYS` moved verbatim, with their doc comments …
```

- [ ] **Step 4: Rewire `smokeChecks.ts`**

Delete the moved declarations; add `import { EXPECTED_PROBE_KEYS, liveSeverity } from "../doctor/liveSeverity";`. Nothing else in that file changes — `liveSeverity`'s return type still satisfies `CheckResult["status"]`.

- [ ] **Step 5: Run the new test and every test that touched the old home**

Run: `pnpm vitest run tests/doctor/liveSeverity.test.ts tests/deploy tests/cli/credsCheck.test.ts && pnpm typecheck`
Expected: PASS, and no test file needed editing — if one imported `PROBE_TIER` from `smokeChecks`, repoint that import rather than re-exporting.

- [ ] **Step 6: Commit**

```bash
git add src/doctor/liveSeverity.ts src/deploy/smokeChecks.ts tests/doctor/liveSeverity.test.ts
git commit -m "refactor(doctor): move the probe severity policy beside the probes"
```

---

### Task 2: The row the deployment records its observation in

**Files:**
- Modify: `src/adapters/db/schema.ts` (one statement appended to `STATEMENTS`)
- Create: `src/status/liveness.ts` (types only in this task)
- Create: `src/adapters/store/PgCredentialLiveness.ts`
- Test: `tests/adapters/store/PgCredentialLiveness.test.ts`

**Interfaces:**
- Produces: `interface StoredProbe { key: ProbeKey; status: ProbeStatus; detail: string }`, `interface LivenessObservation { probes: StoredProbe[]; observedAt: string }`, `class PgCredentialLiveness { read(): Promise<LivenessObservation | undefined>; write(o: LivenessObservation): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/store/PgCredentialLiveness.test.ts
//
// One row: what the deployment last observed about its own credentials, and when. The board's whole
// claim rests on a round trip preserving both — a status without its instant is a status stated as
// though it had just been checked.
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgCredentialLiveness } from "../../../src/adapters/store/PgCredentialLiveness";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const OBSERVATION = {
  observedAt: "2026-08-11T06:23:04.000Z",
  probes: [
    { key: "google_auth", status: "ok", detail: "token refreshed" },
    { key: "telegram", status: "dead", detail: "getMe answered 401" },
  ],
} as const;

describe("PgCredentialLiveness", () => {
  it("reads back exactly what the deployment observed", async () => {
    db = await createTestDb();
    const store = new PgCredentialLiveness(db);
    await store.write(OBSERVATION);
    expect(await store.read()).toEqual(OBSERVATION);
  });

  it("has no observation at all until something probes", async () => {
    // `undefined`, not an empty report: "nothing has ever looked" and "everything answered" are
    // different facts, and the badge shows nothing for the first while showing green for the second.
    db = await createTestDb();
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("keeps one row, replacing it — never a growing log", async () => {
    db = await createTestDb();
    const store = new PgCredentialLiveness(db);
    await store.write({ ...OBSERVATION, observedAt: "2026-08-10T06:23:04.000Z" });
    await store.write(OBSERVATION);
    expect((await store.read())?.observedAt).toBe(OBSERVATION.observedAt);
    const rows = await db.query<{ n: string }>("select count(*) as n from credential_liveness");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("reads a malformed payload as no observation rather than throwing", async () => {
    // The status route calls this on every board load. A row this code cannot parse — hand-edited,
    // or written by a build whose shape has since changed — must degrade to "nothing has looked",
    // never take the header down.
    db = await createTestDb();
    await db.query(
      `insert into credential_liveness (id, probes, observed_at) values ('singleton', $1, $2)`,
      ["{not json", "2026-08-11T06:23:04.000Z"],
    );
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("reads a payload that parses but is not a probe array as no observation", async () => {
    db = await createTestDb();
    await db.query(
      `insert into credential_liveness (id, probes, observed_at) values ('singleton', $1, $2)`,
      [JSON.stringify({ google_auth: "ok" }), "2026-08-11T06:23:04.000Z"],
    );
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("stores the instant as the exact bytes it was given", async () => {
    db = await createTestDb();
    await new PgCredentialLiveness(db).write({ ...OBSERVATION, observedAt: "2026-08-11T06:23:04.123Z" });
    const rows = await db.query<{ observed_at: string }>("select observed_at from credential_liveness");
    expect(rows[0].observed_at).toBe("2026-08-11T06:23:04.123Z");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/adapters/store/PgCredentialLiveness.test.ts`
Expected: FAIL — cannot resolve `PgCredentialLiveness`.

- [ ] **Step 3: Add the table**

Append to `STATEMENTS` in `src/adapters/db/schema.ts`, after `translate_floor_reports`. `TABLE_NAMES` derives itself from the `create table` statements, so this enrolls in `isSchemaApplied` — and therefore in `pnpm doctor`'s Database line — with no second edit.

```ts
  // credential_liveness — LivenessObservation (status/liveness.ts). One row, id 'singleton',
  // upserted by whatever last called `GET /api/diagnostics/live` (the daily `creds:check`, a
  // `deploy:smoke`, or the board's own [지금 확인]).
  //
  // What it is for: liveness is observable from exactly one place — inside the deployment, where the
  // credential is — and the board renders later, somewhere else. On 2026-08-10 the deployment's
  // Google, Typefully and Telegram credentials answered 401 for four days while the header showed
  // every key `설정됨`, because presence is all `/api/status` could see. This is the deployment
  // *recording* what it observed so that screen can read it.
  //
  // Why not a field computed at read time: the probes are ~11 outbound requests under a five-second
  // deadline, and `/api/status` is called on every board load and after every 1차 mutation.
  // `apiHandlers.ts`'s own comment on the diagnostics route refuses that trade in writing.
  //
  // Why its own table rather than `lineage`: `lineage` is `item_id NOT NULL, content NOT NULL` and
  // models per-item content events; a credential observation has neither, and `pnpm lineage
  // --activity` would grow a row per date forever.
  //
  // One row, not one per probe run, for the reason `translate_floor_reports` gives for its own: what
  // a reader needs is the latest observation and how old it is. `probes` is JSON text — `[{ key,
  // status, detail }]`, the three fields the board renders — and every string in it was already
  // redacted by `liveProbes.ts` before it left that module. `observed_at` is never null: a status
  // without its instant reads as though it had just been checked.
  `create table if not exists credential_liveness (
    id text primary key,
    probes text not null,
    observed_at text not null
  )`,
```

- [ ] **Step 4: Write the domain types**

```ts
// src/status/liveness.ts
import type { ProbeKey, ProbeStatus } from "../doctor/liveProbes";

/** The three fields of a probe result the board renders. Deliberately not the whole
 *  `LiveProbeResult`: `grantedScopes`, `quota`, `httpStatus` and `resourceName` serve
 *  `deploy:smoke`'s terminal output and have no reader here. */
export interface StoredProbe {
  key: ProbeKey;
  status: ProbeStatus;
  detail: string;
}

/** What a deployment observed about its own credentials, and when. */
export interface LivenessObservation {
  probes: StoredProbe[];
  observedAt: string;
}
```

- [ ] **Step 5: Write the adapter**

```ts
// src/adapters/store/PgCredentialLiveness.ts
import type { Db } from "../db/Db";
import type { LivenessObservation, StoredProbe } from "../../status/liveness";

interface Row {
  probes: string;
  observed_at: string;
}

/** Same spelling as `PgAttemptLimiter`'s and `PgTranslateFloorReport`'s global row, and for the same
 *  reason: a single-row table still needs a primary key for `on conflict` to conflict on. */
const ROW_ID = "singleton";

/** `value` as a stored probe list, or `undefined` if it is not one. Total over its input on purpose:
 *  the column is text this code wrote, but a row can also be hand-edited or left behind by a build
 *  whose shape has since changed, and the caller is `/api/status` on every board load. */
function parseProbes(value: string): StoredProbe[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const probes: StoredProbe[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { key, status, detail } = entry as { key?: unknown; status?: unknown; detail?: unknown };
    if (typeof key !== "string" || key === "") return undefined;
    if (status !== "ok" && status !== "dead" && status !== "skipped") return undefined;
    if (typeof detail !== "string") return undefined;
    probes.push({ key: key as StoredProbe["key"], status, detail });
  }
  return probes;
}

/**
 * Reads and writes the deployment's last credential observation — one upserted row in
 * `credential_liveness`.
 *
 * **One writer, and it is the deployment itself.** `createDeps`'s `probeLiveness`, immediately after
 * running the probes, on whichever request asked. Not `pnpm creds:check`: that command talks to the
 * deployment over HTTP precisely because the deployment's credentials cannot be read from outside,
 * and a CLI reaching into production Postgres to record what it learned over HTTP would re-open the
 * coupling the HTTP call exists to avoid. Not `pnpm doctor --live` either — it probes the LOCAL
 * `.env`, a different set of objects, and must never land in a row the board reads as the
 * deployment's.
 *
 * **Reader** is `/api/status`, degrading to `undefined` rather than taking the header down — see
 * `createDeps`'s `readLiveness`.
 *
 * Constructed at the call site rather than added to `createStores`, the same treatment
 * `PgAttemptLimiter` and `PgTranslateFloorReport` get: `Stores` is the reviewed-content set that
 * `db:export`/`db:import` move, and this is operational state neither touches.
 */
export class PgCredentialLiveness {
  constructor(private readonly db: Db) {}

  async read(): Promise<LivenessObservation | undefined> {
    const rows = await this.db.query<Row>(
      `select probes, observed_at from credential_liveness where id = $1`,
      [ROW_ID],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const probes = parseProbes(row.probes);
    if (probes === undefined) return undefined;
    return { probes, observedAt: row.observed_at };
  }

  async write(observation: LivenessObservation): Promise<void> {
    await this.db.query(
      `insert into credential_liveness (id, probes, observed_at)
       values ($1, $2, $3)
       on conflict (id) do update set probes = excluded.probes, observed_at = excluded.observed_at`,
      [ROW_ID, JSON.stringify(observation.probes), observation.observedAt],
    );
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/adapters/store/PgCredentialLiveness.test.ts tests/adapters/db/schema.test.ts tests/cli/dbMigrate.test.ts`
Expected: PASS. `schema.test.ts` may assert a table count or list — update it to include `credential_liveness` if it does.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/db/schema.ts src/status/liveness.ts src/adapters/store/PgCredentialLiveness.ts tests/adapters/store/PgCredentialLiveness.test.ts tests/adapters/db/schema.test.ts
git commit -m "feat(db): a row for what the deployment last observed about its credentials"
```

---

### Task 3: Grade an observation into what the badge needs

**Files:**
- Modify: `src/status/liveness.ts` (add `LivenessSummary`, `DeadProbe`, `summarizeLiveness`)
- Test: `tests/status/liveness.test.ts`

**Interfaces:**
- Consumes: `liveSeverity`, `PROBE_TIER` (Task 1); `LivenessObservation`, `StoredProbe` (Task 2).
- Produces: `interface DeadProbe { key: ProbeKey; tier: ProbeTier; severity: "warn" | "fail"; detail: string }`, `interface LivenessSummary { observedAt: string; worst: Severity; dead: DeadProbe[]; total: number }`, `summarizeLiveness(o: LivenessObservation, sendsEnabled: boolean): LivenessSummary`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/status/liveness.test.ts
//
// The server grades; the browser renders. Every rule the chip's colour and wording rest on is
// decided here, where `deploy:smoke`'s own severity table is the one being read.
import { describe, it, expect } from "vitest";
import { summarizeLiveness } from "../../src/status/liveness";

const AT = "2026-08-11T06:23:04.000Z";
const ok = (key: string) => ({ key, status: "ok", detail: "fine" }) as never;
const dead = (key: string, detail = "answered 401") => ({ key, status: "dead", detail }) as never;

describe("summarizeLiveness", () => {
  it("reports ok with no dead probes when everything answered", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [ok("google_auth"), ok("telegram")] }, true);
    expect(summary).toEqual({ observedAt: AT, worst: "ok", dead: [], total: 2 });
  });

  it("counts a skipped probe as ok — presence is deploy:check's job", () => {
    // A Telegram-only install must not go red because Lark Drive is absent.
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [{ key: "lark", status: "skipped", detail: "not configured" } as never] },
      true,
    );
    expect(summary.worst).toBe("ok");
    expect(summary.dead).toEqual([]);
  });

  it("fails on a dead publishing credential and names it with its tier and reason", () => {
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [ok("telegram"), dead("google_auth", "400 invalid_grant")] },
      true,
    );
    expect(summary.worst).toBe("fail");
    expect(summary.dead).toEqual([
      { key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" },
    ]);
  });

  it("softens a dead send credential to warn when sends are closed", () => {
    const probes = { observedAt: AT, probes: [dead("typefully")] };
    expect(summarizeLiveness(probes, true).worst).toBe("fail");
    expect(summarizeLiveness(probes, false).worst).toBe("warn");
    expect(summarizeLiveness(probes, false).dead[0].severity).toBe("warn");
  });

  it("only warns about the Sheet", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [dead("google_sheets")] }, true);
    expect(summary.worst).toBe("warn");
    expect(summary.dead[0].tier).toBe("data");
  });

  it("takes the worst severity present, not the last one seen", () => {
    const summary = summarizeLiveness(
      { observedAt: AT, probes: [dead("google_auth"), dead("google_sheets")] },
      true,
    );
    expect(summary.worst).toBe("fail");
    expect(summary.dead).toHaveLength(2);
  });

  it("grades a key it does not recognise as a failing publish credential", () => {
    // A deployment one probe ahead of this build. Not knowing what a credential is for is graded the
    // same as knowing it is dead — the same argument `liveSeverity`'s default branch makes.
    const summary = summarizeLiveness({ observedAt: AT, probes: [dead("something_new")] }, false);
    expect(summary.worst).toBe("fail");
    expect(summary.dead[0].tier).toBe("publish");
  });

  it("carries the total so the card can say how many probes answered", () => {
    const summary = summarizeLiveness({ observedAt: AT, probes: [ok("google_auth"), ok("lark"), dead("telegram")] }, true);
    expect(summary.total).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/status/liveness.test.ts`
Expected: FAIL — `summarizeLiveness` is not exported.

- [ ] **Step 3: Implement**

```ts
// appended to src/status/liveness.ts
import { PROBE_TIER, liveSeverity, type ProbeTier, type Severity } from "../doctor/liveSeverity";

/** A credential that did not answer, with everything the card needs to name it and everything the
 *  chip needs to word itself. `tier` is carried rather than re-derived in the browser: the tier
 *  table lives on this side, and a copy of it in `web/src` is how the CLI and the header drifted
 *  apart the last time. */
export interface DeadProbe {
  key: ProbeKey;
  tier: ProbeTier;
  severity: "warn" | "fail";
  detail: string;
}

/** What `/api/status` carries about the last observation. Small on purpose — it is on the payload
 *  the board fetches on every load. */
export interface LivenessSummary {
  observedAt: string;
  worst: Severity;
  dead: DeadProbe[];
  total: number;
}

const WORSE: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };

/**
 * Grades one observation with the same policy `deploy:smoke` prints, so a credential that fails a
 * deploy and the same credential on the board can never disagree about how serious it is.
 *
 * `skipped` grades ok alongside `ok`, exactly as `checkLiveness` does: presence is `deploy:check`'s
 * job, and an install that never configured Lark must not read as broken.
 */
export function summarizeLiveness(observation: LivenessObservation, sendsEnabled: boolean): LivenessSummary {
  const dead: DeadProbe[] = [];
  let worst: Severity = "ok";
  for (const probe of observation.probes) {
    if (probe.status !== "dead") continue;
    const severity = liveSeverity(probe.key, sendsEnabled) === "warn" ? "warn" : "fail";
    dead.push({ key: probe.key, tier: PROBE_TIER[probe.key] ?? "publish", severity, detail: probe.detail });
    if (WORSE[severity] > WORSE[worst]) worst = severity;
  }
  return { observedAt: observation.observedAt, worst, dead, total: observation.probes.length };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/status/liveness.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status/liveness.ts tests/status/liveness.test.ts
git commit -m "feat(status): grade a credential observation with deploy:smoke's own policy"
```

---

### Task 4: Record on probe, read on status

**Files:**
- Modify: `src/app/createDeps.ts` (record inside `probeLiveness`; `readLiveness`; the `loadStatus` field)
- Modify: `src/adapters/web/apiHandlers.ts` (`StatusView.liveness`)
- Modify: `tests/support/fakeApiDeps.ts` (widen the `loadStatus` literal)
- Test: `tests/app/createDeps.test.ts`

**Interfaces:**
- Consumes: `PgCredentialLiveness` (Task 2), `summarizeLiveness`/`LivenessSummary` (Task 3).
- Produces: `StatusView.liveness?: LivenessSummary`.

**Note on where the write lives.** The spec says the route is the only writer; in code that is `createDeps`'s `probeLiveness` — the dep the route calls in its one line. Putting it there rather than in `apiHandlers.ts` keeps the handler a pure pass-through, keeps `fakeApiDeps.probeLiveness` untouched, and puts the "best-effort, never fails the route" try/catch next to the thing it is protecting.

- [ ] **Step 1: Write the failing test**

```ts
// added to tests/app/createDeps.test.ts
describe("credential liveness", () => {
  it("records what it just probed, so every caller of the diagnostics route populates the row", async () => {
    const db = await createTestDb();
    try {
      const deps = await createDeps({ /* the harness this file already uses */ });
      await deps.probeLiveness();
      const observation = await new PgCredentialLiveness(db).read();
      expect(observation?.probes.map((p) => p.key)).toContain("google_auth");
      expect(observation?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await db.close();
    }
  });

  it("still answers with the probes when recording them throws", async () => {
    // The route exists to answer when things are broken. A diagnostic that fails because it could
    // not write its own answer down is the same mistake as one that 500s because a probe failed,
    // which `diagnosticsRoute.test.ts` already pins against.
    const db = await createTestDb();
    try {
      await db.query("drop table credential_liveness");
      const deps = await createDeps({ /* same harness */ });
      await expect(deps.probeLiveness()).resolves.toBeInstanceOf(Array);
    } finally {
      await db.close();
    }
  });

  it("reports no liveness at all on a database that has never been probed", async () => {
    const db = await createTestDb();
    try {
      const deps = await createDeps({ /* same harness */ });
      expect((await deps.loadStatus()).liveness).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("grades a recorded observation into the status payload", async () => {
    const db = await createTestDb();
    try {
      await new PgCredentialLiveness(db).write({
        observedAt: "2026-08-11T06:23:04.000Z",
        probes: [{ key: "google_auth", status: "dead", detail: "400 invalid_grant" }],
      });
      const deps = await createDeps({ /* same harness */ });
      const status = await deps.loadStatus();
      expect(status.liveness?.worst).toBe("fail");
      expect(status.liveness?.dead[0]).toMatchObject({ key: "google_auth", tier: "publish" });
    } finally {
      await db.close();
    }
  });

  it("degrades to no liveness rather than 500ing the header when the table is missing", async () => {
    // The hosted deployment is the one reader that does not apply the schema at startup, so between
    // a Vercel deploy and the next `pnpm db:migrate` this code talks to a database without the
    // table. An uncaught 42P01 there renders no header at all. Same window `readFloorReport` closes.
    const db = await createTestDb();
    try {
      await db.query("drop table credential_liveness");
      const deps = await createDeps({ /* same harness */ });
      await expect(deps.loadStatus()).resolves.toMatchObject({ liveness: undefined });
    } finally {
      await db.close();
    }
  });
});
```

> Match the surrounding file: `tests/app/createDeps.test.ts` already builds deps against a test database — reuse its existing setup helper verbatim rather than inventing a second one, and drop the `/* the harness this file already uses */` placeholders for the real call.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/app/createDeps.test.ts`
Expected: FAIL — `liveness` is not on `StatusView`, and nothing writes the row.

- [ ] **Step 3: Add the field to `StatusView`**

```ts
// src/adapters/web/apiHandlers.ts, inside StatusView
  /**
   * How the deployment's credentials answered the last time anything asked — the counterpart to
   * `integrations` above, which reports only that a key is present. Absent when nothing has ever
   * probed (a database predating this field, an install that has never deployed) and when the read
   * failed, both of which read on the board as "nothing has looked" rather than as a claim.
   *
   * Graded here rather than in the browser: `web/src` cannot import `liveSeverity`, and a severity
   * table copied into it is a second policy nothing pins.
   */
  liveness?: LivenessSummary;
```

- [ ] **Step 4: Record inside `probeLiveness`**

```ts
// src/app/createDeps.ts — replacing the existing one-liner at `const probeLiveness = …`
const credentialLiveness = new PgCredentialLiveness(db);

/**
 * … existing doc comment kept …
 *
 * Records what it just observed before answering, which is what makes the daily `creds:check` and
 * every `deploy:smoke` populate the board's badge for free — no new command, no new unit, and no
 * second place that knows how to probe.
 *
 * The write is best-effort and deliberately cannot fail the call: this route's whole purpose is to
 * answer when things are broken.
 */
const probeLiveness = async (): Promise<LiveProbeResult[]> => {
  const probes = await runLiveProbes(buildLiveProbeInput());
  try {
    await credentialLiveness.write({
      observedAt: new Date().toISOString(),
      probes: probes.map(({ key, status, detail }) => ({ key, status, detail })),
    });
  } catch (err) {
    console.warn(`[diagnostics] could not record the credential observation: ${(err as Error).message}`);
  }
  return probes;
};

/** The read above, degraded to `undefined` rather than allowed to take `/api/status` down with it —
 *  the same window, and the same argument, as `readFloorReport`. */
const readLiveness = async (): Promise<LivenessObservation | undefined> => {
  try {
    return await credentialLiveness.read();
  } catch (err) {
    console.warn(`[status] could not read the credential liveness observation: ${(err as Error).message}`);
    return undefined;
  }
};
```

- [ ] **Step 5: Put it on the payload**

In `loadStatus`, beside the existing `const floorReport = await readFloorReport();`:

```ts
    const liveness = await readLiveness();
```

and in the returned object, after `conversionEnabled`:

```ts
      liveness: liveness === undefined ? undefined : summarizeLiveness(liveness, sendsEnabled),
```

- [ ] **Step 6: Widen the fake**

`tests/support/fakeApiDeps.ts`'s `loadStatus` literal is a full `StatusView`; `liveness` is optional, so it compiles unchanged — leave it absent, which is what a deployment that has never probed returns.

- [ ] **Step 7: Run everything that touches status**

Run: `pnpm vitest run tests/app/createDeps.test.ts tests/adapters/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/createDeps.ts src/adapters/web/apiHandlers.ts tests/app/createDeps.test.ts
git commit -m "feat(status): carry the deployment's last credential observation, graded"
```

---

### Task 5: The web mirror and the copy it renders

**Files:**
- Modify: `web/src/types.ts` (mirror `LivenessSummary` onto `AppStatus`)
- Create: `web/src/liveness.ts`
- Modify: `tests/web/typeMirror.test.ts`
- Test: `tests/web/liveness.test.ts`

**Interfaces:**
- Produces: `LIVENESS_STALE_AFTER_MS`, `PROBE_LABEL: Record<string, string>`, `probeLabel(key: string): string`, `livenessChip(summary: LivenessSummary | undefined, now: Date): { text: string; tone: "red" | "amber" } | undefined`, `livenessHeadline(summary: LivenessSummary, now: Date): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/web/liveness.test.ts
//
// What the chip says and what colour it is. Pure copy-builder, tested without a DOM — the same
// treatment `collectedBreakdown.ts` gets, and for the same reason: these rules are the feature.
import { describe, it, expect } from "vitest";
import { livenessChip, livenessHeadline, probeLabel, LIVENESS_STALE_AFTER_MS } from "../../web/src/liveness";

const NOW = new Date("2026-08-11T09:00:00.000Z");
const fresh = "2026-08-11T06:23:00.000Z";      // 2h37m old
const stale = "2026-08-10T05:00:00.000Z";      // 28h old
const summary = (over: Partial<Parameters<typeof livenessChip>[0] & object> = {}) => ({
  observedAt: fresh, worst: "ok" as const, dead: [], total: 7, ...over,
});

describe("livenessChip", () => {
  it("shows nothing when nothing has ever been observed", () => {
    expect(livenessChip(undefined, NOW)).toBeUndefined();
  });

  it("shows nothing when a fresh observation found everything alive", () => {
    // The header must be byte-identical to today's when there is nothing to say.
    expect(livenessChip(summary(), NOW)).toBeUndefined();
  });

  it("goes red and counts the publishing keys that did not answer", () => {
    const chip = livenessChip(
      summary({ worst: "fail", dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "401" }] }),
      NOW,
    );
    expect(chip).toEqual({ text: "발행 키 1개 응답 없음", tone: "red" });
  });

  it("names the send tier when only send credentials died", () => {
    const chip = livenessChip(
      summary({
        worst: "fail",
        dead: [
          { key: "telegram", tier: "send", severity: "fail", detail: "401" },
          { key: "typefully", tier: "send", severity: "fail", detail: "401" },
        ],
      }),
      NOW,
    );
    expect(chip).toEqual({ text: "발송 키 2개 응답 없음", tone: "red" });
  });

  it("goes amber, not red, when the only dead credential is graded warn", () => {
    const chip = livenessChip(
      summary({ worst: "warn", dead: [{ key: "google_sheets", tier: "data", severity: "warn", detail: "404" }] }),
      NOW,
    );
    expect(chip).toEqual({ text: "시트 응답 없음", tone: "amber" });
  });

  it("names the publishing tier first when several tiers died together", () => {
    const chip = livenessChip(
      summary({
        worst: "fail",
        dead: [
          { key: "google_sheets", tier: "data", severity: "warn", detail: "404" },
          { key: "lark", tier: "publish", severity: "fail", detail: "401" },
        ],
      }),
      NOW,
    );
    expect(chip?.text).toBe("발행 키 1개 응답 없음");
  });

  it("warns in amber when nothing has looked in over a day", () => {
    // The daily unit did not run. When this machine is simply off nothing fails, no Telegram
    // arrives, and the board is the only place the silence shows.
    expect(livenessChip(summary({ observedAt: stale }), NOW)).toEqual({ text: "확인 28시간 전", tone: "amber" });
  });

  it("prefers a dead credential over a stale observation when both are true", () => {
    const chip = livenessChip(
      summary({
        observedAt: stale,
        worst: "fail",
        dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "401" }],
      }),
      NOW,
    );
    expect(chip?.text).toBe("발행 키 1개 응답 없음");
  });

  it("does not call a future observation stale", () => {
    // This machine steps its clock, and the observation is stamped by a different one.
    expect(livenessChip(summary({ observedAt: "2026-08-11T09:00:30.000Z" }), NOW)).toBeUndefined();
  });

  it("is one missed daily fire plus margin", () => {
    expect(LIVENESS_STALE_AFTER_MS).toBe(26 * 60 * 60 * 1000);
  });
});

describe("livenessHeadline", () => {
  it("says everything answered, and how long ago", () => {
    expect(livenessHeadline(summary(), NOW)).toBe("7개 모두 응답 · 2시간 전 확인");
  });

  it("says how many did not", () => {
    expect(
      livenessHeadline(
        summary({ worst: "fail", dead: [{ key: "telegram", tier: "send", severity: "fail", detail: "401" }] }),
        NOW,
      ),
    ).toBe("7개 중 1개 응답 없음 · 2시간 전 확인");
  });
});

describe("probeLabel", () => {
  it("names every probe in Korean", () => {
    expect(probeLabel("google_drive_review")).toBe("Drive 검수 폴더");
    expect(probeLabel("telegram")).toBe("Telegram");
  });

  it("falls back to the raw key for a probe this build predates", () => {
    expect(probeLabel("something_new")).toBe("something_new");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/web/liveness.test.ts`
Expected: FAIL — cannot resolve `web/src/liveness`.

- [ ] **Step 3: Mirror the type**

```ts
// web/src/types.ts, appended to AppStatus
  /**
   * How the deployment's credentials answered the last time anything probed them — mirrors the
   * server's `StatusView.liveness` (`apiHandlers.ts`), graded there. Optional for the same reason as
   * `dbEnv` above, and absent also means "nothing has ever looked", which the badge renders as
   * silence rather than as a green claim.
   */
  liveness?: LivenessSummary;
}

/** Mirror of `src/status/liveness.ts`'s `LivenessSummary`. `key` and `tier` are plain strings here:
 *  the browser has no `ProbeKey` union, and an unrecognised key must render (as its raw name) rather
 *  than fail to type. */
export interface LivenessSummary {
  observedAt: string;
  worst: "ok" | "warn" | "fail";
  dead: { key: string; tier: string; severity: "warn" | "fail"; detail: string }[];
  total: number;
}
```

- [ ] **Step 4: Write the copy builder**

```ts
// web/src/liveness.ts
import type { LivenessSummary } from "./types";
import { reportAge } from "./collectedBreakdown";

/**
 * How old an observation may be before the badge says so.
 *
 * Twenty-six hours, from the timer rather than from taste: `deploy/herald-creds.timer` fires
 * `OnCalendar=*-*-* 06:23:00`, so a healthy observation is at most twenty-four hours old plus the
 * run. Twenty-six is one missed fire plus margin.
 *
 * Worth showing at all because the unit's own `OnFailure=` hook cannot cover the case that matters:
 * when this machine is off nothing fails, no Telegram arrives, and the board is the only place the
 * silence shows. Stale is not evidence that anything is wrong — it is evidence that nothing has
 * looked, which is why it reads amber with a time rather than red with a key name.
 */
export const LIVENESS_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const PROBE_LABEL: Record<string, string> = {
  google_auth: "Google 인증",
  google_drive_review: "Drive 검수 폴더",
  google_drive_approved: "Drive 승인 폴더",
  google_sheets: "Google Sheet",
  lark: "Lark",
  typefully: "Typefully",
  telegram: "Telegram",
};

/** The raw key for anything this build predates — a deployment one probe ahead of this bundle names
 *  the credential badly rather than not at all. */
export function probeLabel(key: string): string {
  return PROBE_LABEL[key] ?? key;
}

const TIER_LABEL: Record<string, string> = { publish: "발행 키", send: "발송 키", data: "시트" };
/** Publishing first: it is the tier that stops the pipeline, so it is the one the one-line chip names. */
const TIER_ORDER = ["publish", "send", "data"] as const;

function isStale(observedAt: string, now: Date): boolean {
  const ms = now.getTime() - new Date(observedAt).getTime();
  return !Number.isNaN(ms) && ms > LIVENESS_STALE_AFTER_MS;
}

/**
 * The chip beside the mode pill, or `undefined` when there is nothing to say.
 *
 * Nothing to say is the common case and it must render as today's header exactly — a permanent
 * indicator that is green 364 days a year is one nobody reads on the 365th.
 */
export function livenessChip(
  summary: LivenessSummary | undefined,
  now: Date,
): { text: string; tone: "red" | "amber" } | undefined {
  if (summary === undefined) return undefined;
  if (summary.dead.length > 0) {
    const tier = TIER_ORDER.find((t) => summary.dead.some((d) => d.tier === t)) ?? "publish";
    const count = summary.dead.filter((d) => d.tier === tier).length;
    const text = tier === "data" ? "시트 응답 없음" : `${TIER_LABEL[tier]} ${count}개 응답 없음`;
    return { text, tone: summary.worst === "fail" ? "red" : "amber" };
  }
  if (isStale(summary.observedAt, now)) {
    return { text: `확인 ${reportAge(summary.observedAt, now)}`, tone: "amber" };
  }
  return undefined;
}

/** The hover card's one-line summary. */
export function livenessHeadline(summary: LivenessSummary, now: Date): string {
  const age = `${reportAge(summary.observedAt, now)} 확인`;
  return summary.dead.length === 0
    ? `${summary.total}개 모두 응답 · ${age}`
    : `${summary.total}개 중 ${summary.dead.length}개 응답 없음 · ${age}`;
}
```

- [ ] **Step 5: Pin the mirror**

```ts
// added to tests/web/typeMirror.test.ts
/**
 * The board colours a chip off `worst` and words it off `tier`. If the server ever grades into a
 * value this mirror does not list, the chip renders nothing for the one state it exists to show.
 */
it("mirrors every severity and tier the server can grade into", () => {
  const summary: WebLivenessSummary = {
    observedAt: "2026-08-11T06:23:04.000Z",
    worst: "fail",
    dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "401" }],
    total: 7,
  };
  const server: LivenessSummary = summary;
  expect(server.worst).toBe("fail");
  expect(Object.keys(PROBE_TIER).sort()).toEqual(EXPECTED_PROBE_KEYS.slice().sort());
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/web && pnpm typecheck && pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/types.ts web/src/liveness.ts tests/web/liveness.test.ts tests/web/typeMirror.test.ts
git commit -m "feat(web): the chip's wording and staleness rule, as a tested copy builder"
```

---

### Task 6: The chip, the card section, and [지금 확인]

**Files:**
- Modify: `web/src/api.ts` (add `liveness`)
- Modify: `web/src/App.tsx:198-258` (chip beside the pill; a section in the hover card)
- Test: `web/tests/App.test.tsx`

**Interfaces:**
- Consumes: `livenessChip`, `livenessHeadline`, `probeLabel` (Task 5); `AppStatus.liveness` (Task 4).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Add `/api/diagnostics/live` to `stubFetch` **first** — that helper throws on an unrecognised URL, so every existing `App.test.tsx` case fails the moment the component can call it.

```tsx
// web/tests/App.test.tsx — inside stubFetch's dispatch
    if (url.endsWith("/api/diagnostics/live")) return new Response(JSON.stringify({ probes: [] }), { status: 200 });
```

```tsx
// web/tests/App.test.tsx — new cases
it("shows no liveness chip when the last observation found everything alive", async () => {
  stubFetchWithStatus({ liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], total: 7 } });
  render(<App onSignOut={() => {}} authEpoch={0} />);
  expect(await screen.findByText("cloud")).toBeInTheDocument();
  expect(screen.queryByText(/응답 없음/)).not.toBeInTheDocument();
});

it("shows a red chip naming the tier when a publishing credential is dead", async () => {
  stubFetchWithStatus({
    liveness: {
      observedAt: new Date().toISOString(),
      worst: "fail",
      dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" }],
      total: 7,
    },
  });
  render(<App onSignOut={() => {}} authEpoch={0} />);
  expect(await screen.findByText("⚠ 발행 키 1개 응답 없음")).toBeInTheDocument();
});

it("names the dead credential and its reason in the hover card", async () => {
  stubFetchWithStatus({
    liveness: {
      observedAt: new Date().toISOString(),
      worst: "fail",
      dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "400 invalid_grant" }],
      total: 7,
    },
  });
  render(<App onSignOut={() => {}} authEpoch={0} />);
  expect(await screen.findByText("Google 인증")).toBeInTheDocument();
  expect(screen.getByText("400 invalid_grant")).toBeInTheDocument();
});

it("re-probes and re-reads the status when [지금 확인] is clicked", async () => {
  const fetchMock = stubFetchWithStatus({
    liveness: { observedAt: new Date().toISOString(), worst: "ok", dead: [], total: 7 },
  });
  render(<App onSignOut={() => {}} authEpoch={0} />);
  await screen.findByText("cloud");
  fetchMock.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "지금 확인" }));
  await waitFor(() => {
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain("/api/diagnostics/live");
    expect(urls).toContain("/api/status");
  });
});
```

> `stubFetchWithStatus(extra)` is a thin wrapper over the file's existing `stubFetch` that merges
> `extra` into the `/api/status` body and returns the mock — add it beside `stubFetch` rather than
> duplicating the dispatch.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run web/tests/App.test.tsx`
Expected: FAIL — no chip, no `지금 확인` button.

- [ ] **Step 3: Add the API helper**

```ts
// web/src/api.ts, beside the other helpers
  /**
   * Runs the deployment's credential probes — ~11 outbound requests under a five-second deadline, so
   * only ever from a click. The response body is not read: the route records what it observed, and
   * the caller re-reads `/api/status` for the graded summary rather than grading in the browser.
   */
  liveness: () => json<{ probes: unknown[] }>("/api/diagnostics/live"),
```

- [ ] **Step 4: Render the chip and the card section**

```tsx
// web/src/App.tsx — state, beside the other useState calls
const [checking, setChecking] = useState(false);
const [checkError, setCheckError] = useState<string | null>(null);

const recheckLiveness = () => {
  setChecking(true);
  setCheckError(null);
  api
    .liveness()
    .then(() => api.status().then(setStatus))
    .catch((e) => setCheckError(String(e.message ?? e)))
    .finally(() => setChecking(false));
};

// … in the render, `chip` computed beside `isCloud`:
const chip = livenessChip(status?.liveness, new Date());
```

```tsx
{/* directly after the mode pill's <span>, still inside the `group relative` wrapper */}
{chip && (
  <span
    className={`ml-1.5 inline-flex shrink-0 items-center rounded-full px-2 py-1 text-xs font-medium ${
      chip.tone === "red" ? "bg-red-50 text-red-700" : "bg-amber-soft text-amber-ink"
    }`}
  >
    ⚠ {chip.text}
  </span>
)}
```

```tsx
{/* inside the hover card, after the integrations block and before the closing note */}
{status.liveness && (
  <div className="mt-2 space-y-1 border-t border-line pt-2">
    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">키 응답</div>
    <p className={status.liveness.worst === "ok" ? "text-ink" : "font-medium text-amber-ink"}>
      {livenessHeadline(status.liveness, new Date())}
    </p>
    {status.liveness.dead.map((d) => (
      <div key={d.key} className="flex items-start gap-1.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${d.severity === "fail" ? "bg-red-500" : "bg-amber-ink"}`} />
        <span className="text-ink">{probeLabel(d.key)}</span>
        <span className={`ml-auto text-right ${d.severity === "fail" ? "text-red-600" : "text-amber-ink"}`}>{d.detail}</span>
      </div>
    ))}
    {checkError && <p className="text-red-600">⚠ {checkError}</p>}
  </div>
)}
<div className="mt-2 flex justify-end">
  <button
    type="button"
    className={btn}   {/* `btn` from web/src/buttonStyles.ts — there is no `btnSecondary` */}
    disabled={checking}
    onClick={recheckLiveness}
  >
    {checking ? "확인 중…" : "지금 확인"}
  </button>
</div>
```

> **The card is `pointer-events-none`** (`App.tsx:208`) so a button inside it cannot be clicked. Drop
> that class from the card and add `pointer-events-auto`, or the button renders and does nothing —
> the one defect this task can ship silently. `web/tests/App.test.tsx`'s click case is what catches it.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run web/tests/App.test.tsx && pnpm typecheck:web && pnpm build:web`
Expected: PASS, and `build:web` clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/App.tsx web/tests/App.test.tsx
git commit -m "feat(web): show a dead deployed credential in the header, with a re-check"
```

---

### Task 7: Say so where operators look

**Files:**
- Modify: `docs/ko/env.md` (the badge hover description, ~line 132 and ~263)
- Modify: `docs/ko/deploy.md` (the existing `checkLiveness` severity table gains the board as a third reader)
- Modify: `CHANGELOG.md` (one entry under `[Unreleased]` → `### Added`)

- [ ] **Step 1: Update the badge's own documentation**

`docs/ko/env.md` currently tells the reader the hover card shows `설정됨`/`키 없음`. Add that the card now also carries the last liveness observation and a `지금 확인` button, and that a chip appears beside the badge only when a credential did not answer or nothing has looked in over a day.

- [ ] **Step 2: Update `docs/ko/deploy.md`**

The severity table there describes `deploy:smoke`'s grading. Note that the board reads the same policy out of the same observation, so a credential that fails a deploy and the same credential on the board cannot disagree.

- [ ] **Step 3: Write the CHANGELOG entry**

Under `## [Unreleased]` → `### Added`, in the house style: bolded lead sentence, then what and why, with the 2026-08-10 incident as the motivation and the "presence was green for four days" fact as the evidence. Name the new table, the fact that the route is the only writer, and that `/api/status` gained one single-row read and no outbound calls.

- [ ] **Step 4: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web`
Expected: all green.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/ko/env.md docs/ko/deploy.md CHANGELOG.md
git commit -m "docs(env): the badge says whether the keys still answer, not just that they exist"
git push -u origin design/dashboard-liveness-badge
gh pr create --base main --title "feat(web): show deployed credential liveness in the env badge"
```

---

## Self-review

**Spec coverage.** Table → Task 2. Route-is-the-writer, and why not `creds:check`/`doctor --live` → Task 2's doc comment + Task 4. Grading in one place, moved out of `src/deploy` → Task 1, Task 3. `/api/status` payload, optional, degrading → Task 4. Chip severity table, staleness, 26h → Task 5. Hover card, `지금 확인` → Task 6. Error handling: best-effort write (Task 4 Step 4), malformed payload (Task 2), unmigrated table (Task 4), button failure (Task 6). Docs → Task 7.

**One spec line has no task, deliberately:** "`pnpm doctor --live` does not write" needs no code — it calls `runLiveProbes` directly and never `createDeps`'s `probeLiveness`. Task 2's class comment records the requirement; the day someone routes doctor through the route dep, that comment is what tells them not to.

**Type consistency.** `Severity` and `ProbeTier` are declared once (Task 1) and imported by Tasks 3 and 4. `StoredProbe`/`LivenessObservation` (Task 2) are consumed unchanged by Tasks 3 and 4. `LivenessSummary`'s server shape (Task 3) and web mirror (Task 5) carry the same four fields, pinned in `typeMirror.test.ts`. `livenessChip`/`livenessHeadline`/`probeLabel` are named identically in Tasks 5 and 6.
