# Plan B — Auth: promote the credential check to a real gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No request reaches a use case without a valid session, and the lockout that protects the one password survives across processes.

**Architecture:** PR #87 already verifies the credential; it issues nothing and nothing consults it. This plan adds a signed session cookie, a single chokepoint in `HttpServer` that rejects unauthenticated requests before routing, and a database-backed `AttemptLimiter`. Still local-only — Vercel is Plan C.

**Tech Stack:** Node `crypto` (HMAC for the cookie, scrypt already in use), the `Db` interface from Plan A, vitest.

**Depends on:** Plan A (for `Db`). **Blocks:** Plan C.

**Spec:** `docs/superpowers/specs/2026-07-31-hosted-writes-design.md`, section "Authentication".

## Global Constraints

- Code and commits in **English**; dashboard strings Korean, matching `LoginPage.tsx`.
- **No credential comparison, session parsing, or lockout logic in the browser.** PR #87's commit message states this rule for the login screen; it now applies to the gate.
- The session cookie is `httpOnly`, `Secure`, `SameSite=Lax`, and signed. **Not a JWT** — the auth-options record argued this and it is settled, not reopened.
- Do not weaken `refusalReason()`. It stays, and the session check is added in front of it.
- No route may become reachable without a session except `POST /api/login` and static assets.
- Every task ends with `pnpm test`, `pnpm typecheck` and `pnpm typecheck:web` green.

---

## Task 1: Rebase PR #87 onto the storage branch

**Files:** the three commits on `feat/dashboard-login` (`e290f9b`, `be3da12`, `11f1ccd`)

- [ ] **Step 1: Confirm what is being brought over**

Run: `git log --oneline main..feat/dashboard-login`
Expected: exactly three commits — the auth options spec, the scrypt credential check, the sign-in page.

- [ ] **Step 2: Rebase onto this plan's base**

```bash
git checkout feat/dashboard-login
git rebase <plan-A-branch>
```

Resolve conflicts in `src/adapters/web/apiHandlers.ts` (the login route lands beside routes Plan A left alone) and `web/src/main.tsx`.

- [ ] **Step 3: Full suite**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`
Expected: PASS. PR #87 reported 1073 tests green; Plan A added more.

- [ ] **Step 4: Keep the auth options spec where readers will find it**

`docs/superpowers/specs/2026-07-29-dashboard-auth-options.md` exists only on this branch. It is the record of why a shared account was chosen over Google OIDC, and the 2026-07-31 spec cites it. It comes along with the rebase — confirm it is present and add a `**Superseded by:**` line at its top pointing to `2026-07-31-hosted-writes-design.md`.

- [ ] **Step 5: Commit the pointer**

```bash
git add docs/superpowers/specs/2026-07-29-dashboard-auth-options.md
git commit -m "docs(spec): point the auth options record at the decision that resolved it"
```

---

## Task 2: Database-backed attempt limiter

**Files:**
- Create: `src/adapters/store/PgAttemptLimiter.ts`
- Test: `tests/adapters/store/PgAttemptLimiter.test.ts`
- Modify: `src/adapters/db/schema.ts` (add `auth_attempts`)

**Interfaces:**
- Consumes: `AttemptLimiter` (`src/domain/auth/attemptLimiter.ts`), `Db` (Plan A Task 1)
- Produces: `class PgAttemptLimiter implements AttemptLimiter { constructor(db: Db, options?: { maxFailures?: number; lockoutMs?: number }) }` — against the widened, promise-returning `AttemptLimiter` from Step 1, not a second interface

**Why:** `attemptLimiter.ts`'s own doc comment says it — *"a serverless deployment gets a fresh limiter per instance and would need a shared store to be meaningful."* In-memory, five attempts per instance is effectively unlimited.

- [ ] **Step 1: Note the interface change before writing anything**

`AttemptLimiter` is synchronous (`retryAfterMs(now): number`). A database-backed one cannot be. Widen the port to return promises and update `Login` and the in-memory implementation to match — `Login.run` is already `async`, so its body barely changes. Do this as its own commit so the mechanical change is separable from the new adapter.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgAttemptLimiter } from "../../../src/adapters/store/PgAttemptLimiter";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const t = (ms: number) => new Date(1_800_000_000_000 + ms);

describe("PgAttemptLimiter", () => {
  it("allows attempts until the failure count trips the lockout", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 3, lockoutMs: 60_000 });
    expect(await limiter.retryAfterMs(t(0))).toBe(0);
    await limiter.recordFailure(t(0));
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBe(0);
    await limiter.recordFailure(t(2));
    expect(await limiter.retryAfterMs(t(3))).toBeGreaterThan(0);
  });

  it("shares state across instances — the whole point of moving it off the process", async () => {
    db = await createTestDb();
    const a = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    const b = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await a.recordFailure(t(0));
    await b.recordFailure(t(1));
    expect(await a.retryAfterMs(t(2))).toBeGreaterThan(0);
  });

  it("serving the lockout buys back the whole allowance", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await limiter.recordFailure(t(0));
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBeGreaterThan(0);
    expect(await limiter.retryAfterMs(t(70_000))).toBe(0);
    await limiter.recordFailure(t(70_001));
    expect(await limiter.retryAfterMs(t(70_002))).toBe(0);
  });

  it("a success clears the count", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await limiter.recordFailure(t(0));
    await limiter.recordSuccess();
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/adapters/store/PgAttemptLimiter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Invariants:

- **One counter, not one per client.** `attemptLimiter.ts` explains why: there is a single credential, so keying by IP would only tell an attacker to rotate addresses. One row.
- Port the in-memory semantics exactly, including the "serving the lockout buys back the whole allowance" rule and the reason in its comment — without it, the first typo after the wait re-locks immediately.
- `recordFailure` reads and writes in **one transaction** (`Db.tx`), or two concurrent guesses both read the same count and one failure is lost.
- Read `src/domain/auth/attemptLimiter.ts` in full first. Its comments are the specification.

- [ ] **Step 5: Green, typecheck, commit**

```bash
pnpm vitest run tests/adapters/store/PgAttemptLimiter.test.ts && pnpm test && pnpm typecheck
git add src/adapters/store/PgAttemptLimiter.ts tests/adapters/store/PgAttemptLimiter.test.ts src/adapters/db/schema.ts
git commit -m "feat(auth): move the attempt lockout into the database"
```

---

## Task 3: Signed session cookie

**Files:**
- Create: `src/domain/auth/session.ts`
- Test: `tests/domain/auth/session.test.ts`
- Modify: `src/config.ts` (`loadSessionConfig()`)

**Interfaces:**
- Produces: `signSession(payload, secret): string`; `verifySession(token, secret, now): SessionPayload | undefined`; `loadSessionConfig(): { secret: string; ttlMs: number }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../../../src/domain/auth/session";

const secret = "a".repeat(64);
const issued = new Date("2026-07-31T00:00:00.000Z");
const ttlMs = 12 * 60 * 60 * 1000;

describe("session tokens", () => {
  it("round-trips a payload", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    expect(verifySession(token, secret, issued)).toEqual({ issuedAt: issued.toISOString() });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    expect(verifySession(token, "b".repeat(64), issued)).toBeUndefined();
  });

  it("rejects a tampered payload", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ issuedAt: "2099-01-01T00:00:00.000Z" })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, secret, issued)).toBeUndefined();
    expect(body).not.toBe(forged);
  });

  it("rejects a token past its lifetime", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    const later = new Date(issued.getTime() + ttlMs + 1);
    expect(verifySession(token, secret, later)).toBeUndefined();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", ".", "no-dot", "a.b.c", "!!.??"]) {
      expect(() => verifySession(bad, secret, issued)).not.toThrow();
      expect(verifySession(bad, secret, issued)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/domain/auth/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Invariants:

- HMAC-SHA256 over the base64url payload, compared with `crypto.timingSafeEqual`. `credentials.ts` already compares in constant time — read it and match.
- Lifetime is checked against `issuedAt` inside the payload, so a token cannot outlive it by being replayed with a longer cookie `Max-Age`.
- `verifySession` **never throws**. Malformed input is an unauthenticated request, not a 500.
- `loadSessionConfig()` requires `HERALD_SESSION_SECRET` and refuses a short one. Follow `storage/mode.ts`'s register for the refusal message. Add it to `.env.example` in the auth section with a comment saying how to generate one.

- [ ] **Step 4: Green, typecheck, commit**

```bash
pnpm vitest run tests/domain/auth/session.test.ts && pnpm typecheck
git add src/domain/auth/session.ts tests/domain/auth/session.test.ts src/config.ts .env.example
git commit -m "feat(auth): signed session tokens with a checked lifetime"
```

---

## Task 4: The gate

**Files:**
- Modify: `src/adapters/web/HttpServer.ts`, `src/adapters/web/apiHandlers.ts`
- Test: `tests/adapters/web/gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { handleApi } from "../../../src/adapters/web/apiHandlers";

// Every write route in the API. A new route added without a session check must fail here.
const writeRoutes: [string, string][] = [
  ["PUT", "/api/translations/x:1"],
  ["POST", "/api/translations/x:1/approve"],
  ["POST", "/api/translations/x:1/unapprove"],
  ["POST", "/api/translations/x:1/publish"],
  ["PUT", "/api/renderings/x:1/announcement/telegram"],
  ["POST", "/api/renderings/x:1/announcement/telegram/approve"],
  ["POST", "/api/renderings/x:1/announcement/telegram/unapprove"],
  ["POST", "/api/items/x:1/format"],
  ["POST", "/api/items/x:1/convert-prepare"],
  ["POST", "/api/items/x:1/reconcile"],
  ["PUT", "/api/outlets/x:1/announcement/tg-community"],
  ["POST", "/api/outlets/x:1/announcement/tg-community/send"],
  ["POST", "/api/outlets/x:1/announcement/tg-community/mark"],
];

describe("the gate", () => {
  it.each(writeRoutes)("refuses %s %s without a session", async (method, path) => {
    const result = await handleApi(unauthenticatedDeps(), method, path, {});
    expect(result.status).toBe(401);
  });

  it.each(writeRoutes)("reaches the route with a session: %s %s", async (method, path) => {
    const result = await handleApi(authenticatedDeps(), method, path, {});
    expect(result.status).not.toBe(401);
  });

  it("lets the login route through unauthenticated", async () => {
    const result = await handleApi(unauthenticatedDeps(), "POST", "/api/login", { username: "u", password: "p" });
    expect(result.status).not.toBe(401);
  });

  it("refuses reads without a session too — the board is not public", async () => {
    const result = await handleApi(unauthenticatedDeps(), "GET", "/api/translations", undefined);
    expect(result.status).toBe(401);
  });
});
```

Write `unauthenticatedDeps()` and `authenticatedDeps()` as local helpers returning an `ApiDeps` whose stores are the in-memory doubles already used in `tests/adapters/web/` — read that directory and reuse its existing helper rather than inventing a second one.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/adapters/web/gate.test.ts`
Expected: FAIL — every route returns its normal status; there is no gate.

- [ ] **Step 3: Implement**

Invariants:

- The check is **one chokepoint**, before routing — the shape `refusalReason()` already uses in `HttpServer.ts`. A per-route check is how a route gets forgotten.
- `POST /api/login` is the only exemption. Static assets and the SPA shell are served outside `handleApi` and are unaffected.
- On success, `POST /api/login` sets the cookie: `httpOnly`, `Secure`, `SameSite=Lax`, `Max-Age` matching the token lifetime, `Path=/`.
- Add `POST /api/logout`, which clears the cookie. A session that cannot be ended is the JWT problem the spec rejected.
- 401 carries no detail about why. Distinguishing "no cookie" from "bad signature" tells a guesser which half to work on.
- `refusalReason()` stays exactly as it is. The gate is added in front of it, not merged into it.

- [ ] **Step 4: Green, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add src/adapters/web tests/adapters/web/gate.test.ts
git commit -m "feat(auth): gate every API route behind a session"
```

---

## Task 5: The dashboard handles being logged out

**Files:**
- Modify: `web/src/api.ts`, `web/src/main.tsx`, `web/src/components/LoginPage.tsx`
- Test: `web/tests/` (match the existing frontend test layout)

- [ ] **Step 1: Write the failing test**

```typescript
it("sends the browser to #login when the API answers 401", async () => {
  const onUnauthenticated = vi.fn();
  installUnauthenticatedHandler(onUnauthenticated);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
  await expect(json("/api/translations")).rejects.toThrow();
  expect(onUnauthenticated).toHaveBeenCalledOnce();
});

it("does not redirect on a 400 — a refused action is not a lost session", async () => {
  const onUnauthenticated = vi.fn();
  installUnauthenticatedHandler(onUnauthenticated);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "이미 발송된 방입니다" }), { status: 400 }));
  await expect(json("/api/outlets/x:1/announcement/tg-community/send")).rejects.toThrow();
  expect(onUnauthenticated).not.toHaveBeenCalled();
});
```

- [ ] **Step 2–4: Red, implement, green**

Invariants:

- The 401 handler lives in `web/src/api.ts`'s existing `json()` helper — one place, so no call site can forget.
- A 401 sends the user to `#login`. The second test exists because the board's refusals (`이미 발송된 방입니다`) are 400s and must keep showing their message in place, not bounce anyone to a login screen.
- On successful login the browser navigates back to where it was, not always to the board root.
- Add a sign-out control. `LoginPage.tsx`'s commit describes the visual tokens; match them rather than introducing a new style.
- **Verify in a real browser** at 1280px and 390px: logged-out redirect, login, a 400 refusal staying in place, sign-out. PR #87 set this bar for this screen.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck:web && pnpm build:web
git add web/src web/tests
git commit -m "feat(web): send the dashboard to sign-in when the session is gone"
```

---

## Task 6: Wire the gate into `serve.ts` and document it

**Files:** `src/cli/serve.ts`, `docs/ko/team-runbook.md`, `.env.example`

- [ ] **Step 1: Construct the real limiter and session config**

`serve.ts` builds `PgAttemptLimiter` over the same `Db` as the stores, and reads `loadSessionConfig()`.

An install with no `HERALD_AUTH_USERNAME` / `HERALD_AUTH_PASSWORD_HASH` currently starts and refuses every login (`Login`'s constructor comment explains why the account is optional). That was right when the server was loopback-bound and is wrong now. **`serve.ts` must refuse to start without an account configured**, with a message naming `pnpm auth:hash`.

**Schema note (from Tasks 1–3 fix round 1 review):** `applySchema` is currently called only from
`db-import.ts` and `db-export.ts` — `serve.ts` calls `createDb` and never applies the schema itself.
On a database Plan A already migrated (has `deliveries` etc. but predates `auth_attempts`), nothing
today creates the new table before `PgAttemptLimiter` tries to read or write it, so this step must
either have `serve.ts` call `applySchema(db)` at startup, or establish a real migration step that
runs before the dashboard does — a bare `pnpm serve` must not be the thing that first discovers a
missing table via `relation "auth_attempts" does not exist` on someone's first login attempt.
`isSchemaApplied()` (`src/cli/dbStores.ts`) now checks every table in `schema.ts`'s `TABLE_NAMES`,
not just `deliveries`, so it correctly reports "not applied" for a database missing only
`auth_attempts` — useful for whichever check or startup message this step adds, but it does not by
itself create the table.

- [ ] **Step 2: Update the security note in `HttpServer.ts`**

The file says the model is "no auth, bound to loopback". That is no longer true. Rewrite that comment to describe what actually guards the server now, and what it does not guard against.

- [ ] **Step 3: Runbook**

`docs/ko/team-runbook.md` is Korean-first. Document: signing in, what to do when signed out mid-review, rotating the password with `pnpm auth:hash`, and that the account is shared so a rotation must be told to everyone.

- [ ] **Step 4: Full suite, browser check, commit**

```bash
pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web
git add src/cli/serve.ts src/adapters/web/HttpServer.ts docs/ko/team-runbook.md .env.example
git commit -m "feat(auth): require an account to start the dashboard"
```

---

## Done when

- Every route in `apiHandlers.ts` except `POST /api/login` answers 401 without a session, proven by a table-driven test that a new route cannot silently escape
- `pnpm serve` refuses to start without an account configured
- The lockout survives a process restart
- Signing out ends the session server-side
- Browser-verified at 1280px and 390px

**Not in this plan:** anything Vercel, the deployment origin allowlist, secrets in a hosted environment. Those are Plan C.
