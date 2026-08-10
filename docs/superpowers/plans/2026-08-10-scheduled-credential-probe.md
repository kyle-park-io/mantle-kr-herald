# Scheduled Credential Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask the deployment once a day whether its own credentials still work, and send a Telegram alert when a publishing credential is dead.

**Architecture:** A shared client owns logging in and carrying the session, so an authenticated call cannot be made without one. A thin CLI logs in, reads `/api/diagnostics/live`, judges it with the existing `checkLiveness`, and exits non-zero. A systemd timer runs it through the wrapper and hook the three existing scheduled units already use.

**Tech Stack:** TypeScript (ESM), tsx, Vitest, systemd user units.

**Spec:** `docs/superpowers/specs/2026-08-10-scheduled-credential-probe-design.md`

## Global Constraints

- **An unattended command must never prompt.** `smokeCredentials` returns `{kind:"prompt"}` when neither `HERALD_SMOKE_*` is set; under a timer that blocks on stdin until `TimeoutStartSec` kills it, and the operator then gets a Telegram alert saying a credential check failed when the check never ran. An alert that misreports its own cause is worse than no alert.
- **Not knowing is not the same as being fine.** An unreadable route — deployment down, 401, 500, malformed body — is a `fail`.
- Relative imports carry no file extension. The repo has ~1015 such imports and `pnpm build:api` bundles around it.
- CLI output is English. Korean stays for the dashboard and `docs/ko/`.
- git identity is missing on this machine — commit with `git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' commit …`.
- Work on branch `design/scheduled-credential-probe`, which already holds the spec commit `ea43b7c`.
- Existing conventions in `tests/deploy/`: run the real script/CLI against temp directories or a stub server, and read unit/script files as text for wiring assertions.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/deploy/deploymentSession.ts` (create) | Talking to a deployment: one HTTP helper, log in, and authenticated calls that carry the cookie by construction. |
| `tests/deploy/deploymentSession.test.ts` (create) | The client against an injected fetch. |
| `src/cli/deploy-smoke.ts` (modify) | Stops hand-rolling login and cookie plumbing; uses the client. |
| `tests/deploy/smokeSession.test.ts` (modify) | Its source-parsing guard is repointed at the new invariant. |
| `src/cli/creds-check.ts` (create) | The scheduled command: log in, read the report, judge, exit. |
| `package.json` (modify) | Registers `creds:check`. |
| `tests/cli/credsCheck.test.ts` (create) | The real CLI against a stub deployment. |
| `deploy/herald-creds.service`, `deploy/herald-creds.timer` (create) | The unit and its daily timer. |
| `tests/deploy/credsTiming.test.ts` (create) | Unit and timer as text. |
| `docs/ko/team-runbook.md` (modify) | Install step for the fourth unit. |

---

### Task 1: The deployment client

**Files:**
- Create: `src/deploy/deploymentSession.ts`
- Test: `tests/deploy/deploymentSession.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DeploymentClient { readonly origin: string; readonly loggedIn: boolean; request(path: string, init?: RequestInit): Promise<Response | undefined>; logIn(username: string, password: string): Promise<number>; authed(path: string, init?: RequestInit): Promise<Response | undefined>; forgetSession(): void }`
  - `createDeploymentClient(origin: string, fetchFn?: typeof fetch, onError?: (message: string) => void): DeploymentClient`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/deploymentSession.test.ts`:

```ts
// tests/deploy/deploymentSession.test.ts
//
// This module exists because of one bug. On 2026-08-10 `deploy-smoke.ts` called
// /api/diagnostics/live without the session cookie every sibling call passed; the route answered 401
// on every run and the feature it had just shipped never once executed. A full green suite and four
// clean task reviews said nothing about it.
//
// The fix is not "remember the cookie". It is `authed()`: the cookie is attached inside the client,
// so a caller cannot make an authenticated request without one. The tests below pin that property
// rather than any particular call site's spelling.
import { describe, it, expect } from "vitest";
import { createDeploymentClient } from "../../src/deploy/deploymentSession";

const ok = (body: unknown = {}, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers });

/** Records what the client actually sent, so the assertions are about the wire, not the call. */
function recorder(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const LOGIN_OK = ok({ ok: true }, { "set-cookie": "herald_session=abc123; Path=/; HttpOnly" });

describe("createDeploymentClient", () => {
  it("sends the deployment's own Origin on a login, so the CSRF guard does not refuse it", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    expect(calls[0].url).toBe("https://example.test/api/login");
    expect((calls[0].init?.headers as Record<string, string>).origin).toBe("https://example.test");
  });

  it("returns the login status and remembers the session", async () => {
    const { fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    expect(await client.logIn("u", "p")).toBe(200);
    expect(client.loggedIn).toBe(true);
  });

  it("does not consider itself logged in when the login is refused", async () => {
    const { fetchFn } = recorder(() => new Response("{}", { status: 401 }));
    const client = createDeploymentClient("https://example.test", fetchFn);
    expect(await client.logIn("u", "bad")).toBe(401);
    expect(client.loggedIn).toBe(false);
  });

  // The load-bearing test of this file.
  it("attaches the cookie to every authed call — the caller cannot omit it", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    await client.authed("/api/status");
    await client.authed("/api/diagnostics/live");
    for (const call of calls.slice(1)) {
      expect((call.init?.headers as Record<string, string>).cookie, call.url).toBe("herald_session=abc123");
    }
  });

  it("keeps headers the caller passed while adding the cookie", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    await client.authed("/api/thing", { method: "POST", headers: { "content-type": "application/json" } });
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("herald_session=abc123");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("refuses an authed call before login rather than sending an unauthenticated one", async () => {
    // Silently sending it is how the original bug looked from the outside: a 401 that reads like the
    // deployment's fault.
    const { calls, fetchFn } = recorder(() => ok());
    const client = createDeploymentClient("https://example.test", fetchFn);
    await expect(client.authed("/api/status")).rejects.toThrow(/log in/i);
    expect(calls).toHaveLength(0);
  });

  it("forgets the session on request, so a stale cookie can never be resent", async () => {
    const { fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    client.forgetSession();
    expect(client.loggedIn).toBe(false);
    await expect(client.authed("/api/status")).rejects.toThrow(/log in/i);
  });

  it("returns undefined and reports, rather than throwing, when the network fails", async () => {
    const messages: string[] = [];
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createDeploymentClient("https://example.test", fetchFn, (m) => messages.push(m));
    expect(await client.request("/")).toBeUndefined();
    expect(messages.join("\n")).toContain("ECONNREFUSED");
  });

  it("reports -1 for a login that never completed", async () => {
    const fetchFn = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const client = createDeploymentClient("https://example.test", fetchFn, () => {});
    expect(await client.logIn("u", "p")).toBe(-1);
    expect(client.loggedIn).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/deploymentSession.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/deploy/deploymentSession"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/deploy/deploymentSession.ts`:

```ts
/**
 * Talking to a deployed instance: one HTTP helper, a login, and authenticated calls.
 *
 * The reason this is a module and not two functions is a bug it makes unrepresentable. On
 * 2026-08-10 `deploy-smoke.ts` called `/api/diagnostics/live` without the session cookie that every
 * sibling call passed. The route is gated like every route but `/api/login`, so it answered 401 on
 * every run, `probes` came back `undefined`, and the liveness check reported "the deployment could
 * not be read" — for a deployment that was perfectly healthy. The feature had never once executed,
 * and a full green suite plus four clean reviews had nothing to say about it.
 *
 * So the cookie is not a header a caller remembers to add. `authed()` attaches it, and refuses
 * outright before login rather than quietly sending an unauthenticated request that would come back
 * looking like the deployment's fault.
 */

export interface DeploymentClient {
  /** Scheme + host only — the exact shape the CSRF guard compares an `Origin` against. */
  readonly origin: string;
  readonly loggedIn: boolean;
  /** One call, or `undefined` on a network failure. Never throws. */
  request(path: string, init?: RequestInit): Promise<Response | undefined>;
  /** POSTs `/api/login` and remembers the session. Returns the status, or -1 if it never completed. */
  logIn(username: string, password: string): Promise<number>;
  /** A call carrying the session. Throws if there is no session — see the module comment. */
  authed(path: string, init?: RequestInit): Promise<Response | undefined>;
  forgetSession(): void;
}

export function createDeploymentClient(
  origin: string,
  fetchFn: typeof fetch = fetch,
  onError: (message: string) => void = (m) => console.error(m),
): DeploymentClient {
  let cookie: string | undefined;

  const request = async (path: string, init?: RequestInit): Promise<Response | undefined> => {
    try {
      return await fetchFn(`${origin}${path}`, init);
    } catch (err) {
      onError(`  (request to ${path} failed: ${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
  };

  return {
    origin,
    get loggedIn(): boolean {
      return cookie !== undefined;
    },
    request,
    async logIn(username: string, password: string): Promise<number> {
      const res = await request("/api/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res?.status === 200) cookie = res.headers.get("set-cookie")?.split(";")[0];
      return res?.status ?? -1;
    },
    async authed(path: string, init?: RequestInit): Promise<Response | undefined> {
      if (cookie === undefined) {
        throw new Error(`authed(${path}) called before a successful log in — this is a programming error`);
      }
      return request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } });
    },
    forgetSession(): void {
      cookie = undefined;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/deploymentSession.test.ts` — expect 9 passed.
Then `pnpm typecheck` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/deploymentSession.ts tests/deploy/deploymentSession.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): make an authenticated call impossible without the session"
```

---

### Task 2: `deploy:smoke` uses the client

Behaviour-preserving. The point is that one module owns the session before a second CLI starts using it.

**Files:**
- Modify: `src/cli/deploy-smoke.ts`
- Modify: `tests/deploy/smokeSession.test.ts`

**Interfaces:**
- Consumes: `createDeploymentClient`, `DeploymentClient` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Capture the current output as the baseline**

```bash
pnpm deploy:smoke https://mantle-kr-herald.vercel.app 2>&1 | tee /tmp/smoke-before.txt | tail -3
```

It prompts for the dashboard password. If you cannot supply one, say so in your report and skip to Step 2 — but say it plainly rather than implying the comparison happened.

- [ ] **Step 2: Read the existing guard before changing anything**

`tests/deploy/smokeSession.test.ts` parses `deploy-smoke.ts`'s **source** and asserts every authenticated call carries `{ headers: { cookie } }`. It was written after the 2026-08-10 Critical and it works by text matching. Once `authed()` exists, that spelling disappears and the test fails — correctly, because what it guards moved.

Read it in full before editing. You are repointing a regression guard, not deleting an inconvenient test.

- [ ] **Step 3: Rewire the CLI**

Replace the local `request` helper and the `cookie` variable with the client. Build it once, after `origin` is derived:

```ts
const client = createDeploymentClient(origin);
```

Then:
- `request(path, init)` → `client.request(path, init)`
- `statusOf` keeps its shape but calls `client.request`
- the login block → `const loginStatus = await client.logIn(username, password);` and `checkLogin(loginStatus)`
- `if (cookie)` → `if (client.loggedIn)`
- every `request(path, { headers: { cookie } })` → `client.authed(path)`
- the post-logout cookie drop → `client.forgetSession()`

Add the import:

```ts
import { createDeploymentClient } from "../deploy/deploymentSession";
```

- [ ] **Step 4: Repoint the guard**

The old assertion — "every authenticated call spells `{ headers: { cookie } }`" — is now unrepresentable rather than merely unwritten, so replace it with one that guards the new shape:

```ts
it("makes no authenticated call through the raw request helper", () => {
  // The 2026-08-10 Critical was one authenticated call that forgot the cookie. `authed()` now
  // attaches it, so the way to reintroduce that bug is to bypass `authed()` and call `request()`
  // for a route that needs a session. This is what that would look like, and it fails here.
  const source = readFileSync(resolve(repoRoot, "src/cli/deploy-smoke.ts"), "utf8");
  const authedPaths = ["/api/status", "/api/diagnostics/live", "/api/logout", "/api/items/"];
  for (const path of authedPaths) {
    const viaRequest = new RegExp(String.raw`client\.request\(\s*["'\`][^"'\`]*${path.replace(/\//g, "\\/")}`);
    expect(source, `${path} must go through client.authed(), not client.request()`).not.toMatch(viaRequest);
  }
  expect(source).toContain("client.authed(");
});
```

Keep every other assertion in the file that still describes something true.

- [ ] **Step 5: Run tests and compare**

Run: `pnpm test && pnpm typecheck`
Expected: green.

Then re-run the smoke against the real deployment and diff against Step 1's baseline:

```bash
pnpm deploy:smoke https://mantle-kr-herald.vercel.app 2>&1 | tee /tmp/smoke-after.txt | tail -3
diff /tmp/smoke-before.txt /tmp/smoke-after.txt || true
```

**Report the diff in full rather than judging it.** The check names and their ok/warn/fail verdicts must be identical; this task changes plumbing, not findings.

- [ ] **Step 6: Commit**

```bash
git add src/cli/deploy-smoke.ts tests/deploy/smokeSession.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "refactor(deploy): run deploy:smoke's session through the shared client"
```

---

### Task 3: `pnpm creds:check`

**Files:**
- Create: `src/cli/creds-check.ts`
- Modify: `package.json` (scripts)
- Test: `tests/cli/credsCheck.test.ts`

**Interfaces:**
- Consumes: `createDeploymentClient` from Task 1; `smokeCredentials` from `src/cli/smokeCredentials`; `checkLiveness(probes: unknown, sendsEnabled: boolean, httpStatus?: number): CheckResult[]` from `src/deploy/smokeChecks`; `formatReport` from `src/doctor/report`.
- Produces: the CLI contract Task 4's unit depends on — `pnpm creds:check [url]`, origin from argv or `HERALD_DEPLOYMENT_ORIGIN`; exit 0 when nothing failed, 1 when something did, 2 on a usage or configuration error.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/credsCheck.test.ts`:

```ts
// tests/cli/credsCheck.test.ts
//
// Runs the real CLI against a stub deployment on localhost, the convention tests/deploy/ uses for
// deploy scripts: execute the real thing, never a stand-in for it.
//
// The case worth naming is the last one. With HERALD_SMOKE_* unset, `smokeCredentials` returns
// `{kind:"prompt"}` — right for a human running deploy:smoke, fatal under a timer, where the process
// blocks on stdin until TimeoutStartSec kills the unit and the operator gets an alert saying a
// credential check failed when the check never ran. A test that merely asserted a non-zero exit
// would pass on a hang too, so that test asserts the process RETURNS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

const repoRoot = resolve(__dirname, "../..");

/** What the stub's /api/diagnostics/live answers with; each test sets it before spawning. */
let probes: unknown = [];
let liveStatus = 200;
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/login") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "herald_session=stub; Path=/" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!(req.headers.cookie ?? "").includes("herald_session=")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    if (url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sendsEnabled: false }));
      return;
    }
    if (url === "/api/diagnostics/live") {
      res.writeHead(liveStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ probes }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(env: Record<string, string | undefined> = {}, args: string[] = [origin]) {
  return spawnSync("pnpm", ["-s", "creds:check", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HERALD_SMOKE_USERNAME: "probe",
      HERALD_SMOKE_PASSWORD: "probe-password",
      ...env,
    },
  });
}

const ALL_OK = [
  { key: "google_auth", status: "ok", detail: "token refreshed" },
  { key: "google_drive_review", status: "ok", detail: "reachable" },
  { key: "google_drive_approved", status: "ok", detail: "reachable" },
  { key: "google_sheets", status: "ok", detail: "reachable" },
  { key: "lark", status: "ok", detail: "tenant token issued" },
  { key: "typefully", status: "ok", detail: "social set reachable" },
  { key: "telegram", status: "ok", detail: "bot token valid" },
];

describe("pnpm creds:check", () => {
  it("exits 0 when every probe is alive", () => {
    probes = ALL_OK;
    liveStatus = 200;
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("live: google_auth");
  });

  it("exits 1 when a publishing credential is dead", () => {
    probes = ALL_OK.map((p) => (p.key === "google_auth" ? { ...p, status: "dead", detail: "HTTP 401" } : p));
    liveStatus = 200;
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("google_auth");
  });

  it("does not fail on a dead send credential while sends are closed", () => {
    // The stub reports sendsEnabled: false, so this is a warn — matching checkLiveness's own rule.
    probes = ALL_OK.map((p) => (p.key === "telegram" ? { ...p, status: "dead", detail: "HTTP 401" } : p));
    liveStatus = 200;
    expect(run().status).toBe(0);
  });

  it("exits 1 when the route cannot be read", () => {
    probes = [];
    liveStatus = 500;
    expect(run().status).toBe(1);
  });

  it("takes the origin from HERALD_DEPLOYMENT_ORIGIN when no argument is given", () => {
    probes = ALL_OK;
    liveStatus = 200;
    const r = run({ HERALD_DEPLOYMENT_ORIGIN: origin }, []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  // The one a hang would otherwise hide.
  it("refuses immediately when HERALD_SMOKE_* is unset, instead of blocking on a prompt", () => {
    probes = ALL_OK;
    liveStatus = 200;
    const r = run({ HERALD_SMOKE_USERNAME: undefined, HERALD_SMOKE_PASSWORD: undefined });
    expect(r.error, "the process must return, not hang until the harness timeout").toBeUndefined();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("HERALD_SMOKE_USERNAME");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/credsCheck.test.ts`
Expected: FAIL — `ERR_PNPM_NO_SCRIPT`, `creds:check` is not a script yet.

- [ ] **Step 3: Write the implementation**

Create `src/cli/creds-check.ts`:

```ts
/**
 * Asks a deployment whether its own credentials still work, and exits non-zero when a publishing
 * one does not. Built to be run by `deploy/herald-creds.timer`, which is why it never prompts.
 *
 * `pnpm deploy:smoke` answers a different question — is this deployment correctly shaped and
 * reachable — with twenty-odd checks, most of which have nothing to do with credentials. Running
 * that on a timer would alert on a route-shape assertion at 06:23 and teach the operator to ignore
 * the channel, so this command does one thing.
 */
import "./registerErrorHandler";
import { createDeploymentClient } from "../deploy/deploymentSession";
import { checkLiveness } from "../deploy/smokeChecks";
import { smokeCredentials } from "./smokeCredentials";
import { formatReport, type CheckResult } from "../doctor/report";

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const rawUrl = positional[0] ?? process.env.HERALD_DEPLOYMENT_ORIGIN?.trim();

if (!rawUrl) {
  console.error("Usage: pnpm creds:check <url>   (or set HERALD_DEPLOYMENT_ORIGIN)");
  process.exit(2);
}

let deployment: URL;
try {
  deployment = new URL(rawUrl);
} catch {
  console.error(`Not a valid URL: ${rawUrl}`);
  process.exit(2);
}

// Scheme + host only, the shape the deployment's CSRF guard compares an `Origin` against.
const client = createDeploymentClient(deployment.origin);

// No prompt fallback, unlike `deploy:smoke`. A timer has no stdin: prompting blocks until
// TimeoutStartSec kills the unit, and the operator then gets a Telegram alert saying a credential
// check failed when the check never ran. Refuse, name the variables, and exit.
const source = smokeCredentials({
  HERALD_SMOKE_USERNAME: process.env.HERALD_SMOKE_USERNAME,
  HERALD_SMOKE_PASSWORD: process.env.HERALD_SMOKE_PASSWORD,
});
if (source.kind !== "env") {
  console.error(
    source.kind === "refuse"
      ? source.reason
      : "HERALD_SMOKE_USERNAME and HERALD_SMOKE_PASSWORD must both be set — this command runs unattended and never prompts.",
  );
  process.exit(2);
}

const results: CheckResult[] = [];

const loginStatus = await client.logIn(source.username, source.password);
if (loginStatus !== 200) {
  results.push({
    name: "login",
    status: "fail",
    detail: `POST /api/login answered ${loginStatus === -1 ? "nothing — the deployment was unreachable" : loginStatus}.`,
  });
} else {
  // `sendsEnabled` decides whether a dead send credential is a warn or a fail, and it comes from the
  // deployment itself so the check tightens exactly when sends open.
  const statusRes = await client.authed("/api/status");
  const statusBody = (statusRes ? await statusRes.json().catch(() => undefined) : undefined) as
    | { sendsEnabled?: boolean }
    | undefined;

  const liveRes = await client.authed("/api/diagnostics/live");
  const liveBody = (liveRes && liveRes.ok ? await liveRes.json().catch(() => undefined) : undefined) as
    | { probes?: unknown }
    | undefined;

  results.push(...checkLiveness(liveBody?.probes, statusBody?.sendsEnabled === true, liveRes?.status));
}

console.log(formatReport(results, { title: `Mantle KR Herald — credential liveness (${client.origin})` }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
```

Add to `package.json` `scripts`, immediately after `"deploy:smoke"`:

```json
    "creds:check": "tsx --env-file-if-exists=.env src/cli/creds-check.ts",
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/cli/credsCheck.test.ts` — expect 6 passed.
Then `pnpm test && pnpm typecheck` — expect green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/creds-check.ts package.json tests/cli/credsCheck.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): add pnpm creds:check, the unattended liveness check"
```

---

### Task 4: The unit, the timer, and the runbook

**Files:**
- Create: `deploy/herald-creds.service`, `deploy/herald-creds.timer`
- Test: `tests/deploy/credsTiming.test.ts`
- Modify: `docs/ko/team-runbook.md`

**Interfaces:**
- Consumes: `pnpm creds:check` from Task 3.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/credsTiming.test.ts`:

```ts
// tests/deploy/credsTiming.test.ts
//
// The unit and timer as text, the convention the rest of tests/deploy/ uses. Three properties are
// worth pinning and none is visible from the CLI's own tests.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const deployDir = resolve(repoRoot, "deploy");
const service = readFileSync(join(deployDir, "herald-creds.service"), "utf8");
const timer = readFileSync(join(deployDir, "herald-creds.timer"), "utf8");

const directives = (unit: string): string[] =>
  unit.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

describe("herald-creds.service", () => {
  it("runs from the deploy checkout, through the wrapper, with its own unit name", () => {
    const execStart = directives(service).find((l) => l.startsWith("ExecStart="));
    expect(execStart).toContain("%h/.herald/app/deploy/herald-run-logged.sh %n");
    expect(execStart).toContain("%h/.herald/bin/pnpm creds:check");
  });

  it("alerts on failure through the shared hook", () => {
    // Without this the check runs, finds a dead credential, exits 1, and nobody hears about it —
    // which is the whole point of scheduling it.
    expect(directives(service)).toContainEqual("OnFailure=herald-notify-failure@%n.service");
  });

  it("names no database, because this command opens none", () => {
    // The other three units read %h/.herald/prod.env for DATABASE_URL. Naming it here would imply a
    // dependency that does not exist — the same argument herald-x-reconcile.service makes about not
    // setting HERALD_OUTPUT_DIR for a command that touches no output tree.
    expect(directives(service).filter((l) => l.startsWith("EnvironmentFile="))).toEqual([]);
  });
});

describe("herald-creds.timer", () => {
  it("fires once a day", () => {
    const onCalendar = directives(timer).find((l) => l.startsWith("OnCalendar="));
    expect(onCalendar).toBe("OnCalendar=*-*-* 06:23:00");
  });

  it("catches up a fire missed while the machine was off", () => {
    expect(directives(timer)).toContainEqual("Persistent=true");
  });

  it("does not share a minute with any other scheduled unit", () => {
    // Units sharing a minute buy nothing and invite two pnpm processes starting at once on a cold
    // store — herald-x-reconcile.timer's own header makes this argument. Derived from the directory
    // so a timer added later is included without editing this list.
    const minutesOf = (text: string): string[] =>
      [...text.matchAll(/^OnCalendar=.*?(\d{1,2}):(\d{2}):\d{2}\s*$/gm)].map((m) => m[2]);
    const others = readdirSync(deployDir)
      .filter((f) => f.endsWith(".timer") && f !== "herald-creds.timer")
      .flatMap((f) => minutesOf(readFileSync(join(deployDir, f), "utf8")));
    expect(others.length, "no other timers found — the check would pass vacuously").toBeGreaterThan(0);
    expect(others).not.toContain("23");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/credsTiming.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, open '.../deploy/herald-creds.service'`.

- [ ] **Step 3: Write the unit**

Create `deploy/herald-creds.service`:

```ini
# deploy/herald-creds.service
#
# systemd --user unit for one `pnpm creds:check` — asks the DEPLOYMENT whether its own credentials
# still work, and exits non-zero when a publishing one does not.
#
# Why this exists: `pnpm deploy:smoke` learned to catch a dead deployed credential on 2026-08-10,
# but only at deploy time. The incident that prompted it happened BETWEEN deploys — the deployment's
# Google, Typefully and Telegram credentials answered 401 for four days while `deploy:check` passed
# 40 ok and the board reported `availableTargets: google — present`. Nothing ran in between that
# asked. This does, once a day.
#
# It cannot be answered locally: Vercel stores those values --sensitive, so they cannot be read back
# at all, and the local .env holds a different set of objects — green here for the whole four days.
# The probes therefore run inside the deployment and this unit only asks.
#
# NOT installed by any committed script. Copying this into ~/.config/systemd/user/ and running
# `systemctl --user daemon-reload` is a human-supervised step (see the team runbook), same as the
# other three units.

[Unit]
Description=Mantle KR Herald credential liveness — asks the deployment whether its credentials still work
# The same templated hook the other three scheduled units use. `%n` expands to this unit's own name
# before systemd resolves the target, so the alert names this unit and not another's.
OnFailure=herald-notify-failure@%n.service

[Service]
Type=oneshot
# The deploy checkout — merged `main` only. Same reasoning as every other unit: whatever is checked
# out here IS what runs at the next fire.
WorkingDirectory=%h/.herald/app

# node and pnpm are reached through %h/.herald/bin, a directory of symlinks, NOT an nvm version
# directory — see herald-watch.service's own PATH comment for the 2026-08-09 rebuild that made this
# necessary. `claude` is not on this path deliberately: this command spawns no agent.
Environment=PATH=%h/.herald/bin:/home/kyle/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# No EnvironmentFile=%h/.herald/prod.env, unlike the other three. This command opens no database —
# it makes three HTTP calls to the deployment and judges the answer. Naming prod.env would imply a
# dependency that does not exist, the same reason herald-x-reconcile.service sets no
# HERALD_OUTPUT_DIR. Everything it needs — HERALD_SMOKE_USERNAME, HERALD_SMOKE_PASSWORD and
# HERALD_DEPLOYMENT_ORIGIN — comes from the frozen .env via its own `tsx --env-file-if-exists=.env`.
#
# HERALD_SMOKE_* is the dashboard password ITSELF, not the scrypt hash. .env.example sanctions that
# for exactly this case ("in CI, from a deploy script, or unattended") and forbids it on Vercel in
# the same breath: this runs on your machine and knocks on the deployment as a client.

# The route bounds its own probe run at five seconds and the three calls around it are ordinary
# round trips; a real run takes a few seconds. 120s is a generous multiple that still fails long
# before a daily cadence could overlap itself.
TimeoutStartSec=120

# Wrapped in herald-run-logged.sh for the reason every other unit is: journald on this box holds
# roughly eight minutes of history, so a run at 06:23 leaves nothing to read by the time anyone
# looks. The wrapper tees a durable per-run log under ~/.herald/logs/ and hands the command's exit
# status back unchanged — the status is what OnFailure= above depends on.
#
# No URL argument: `creds:check` falls back to HERALD_DEPLOYMENT_ORIGIN, which the frozen .env
# already carries and `deploy:check` already validates against the real Vercel domain. One value,
# one place.
ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm creds:check
```

Create `deploy/herald-creds.timer`:

```ini
# deploy/herald-creds.timer
#
# Fires herald-creds.service once a day at 06:23, before the working day.
#
# Daily, not hourly. The failure is rare and slow-moving — the incident this responds to ran four
# days — and a dead credential alerts on EVERY fire until it is fixed. Hourly would mean 24 Telegram
# messages a day for one problem, which is how an alert channel becomes noise people stop reading.
#
# :23 is off :00 for the reason herald-watch.timer's :17 is, and off :07/:37 (convert), :17 (watch)
# and :41 (x-reconcile) specifically: units sharing a minute buy nothing and invite two pnpm
# processes starting at once on a cold store. tests/deploy/credsTiming.test.ts derives the other
# timers' minutes from deploy/ and asserts this one differs, so a later edit cannot collide unnoticed.
#
# NOT installed by any committed script — see herald-creds.service's header.

[Unit]
Description=Timer for herald-creds.service — daily credential liveness check against the deployment

[Timer]
OnCalendar=*-*-* 06:23:00
# Runs once on the next boot/login if the machine was off through a scheduled fire, instead of
# silently skipping the day. Same reasoning as the other three timers.
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Run tests and validate the calendar**

```bash
pnpm vitest run tests/deploy/credsTiming.test.ts
systemd-analyze calendar '*-*-* 06:23:00'
```

Expected: 6 passed, and the calendar parses reporting a daily 06:23 schedule. Paste the
`systemd-analyze` output into your report — the other timers' headers record theirs and this one
should too.

- [ ] **Step 5: Document the install**

In `docs/ko/team-runbook.md`, find the `cp … ~/.config/systemd/user/` block (around line 1369).

**It is already incomplete, and fixing that is part of this step.** It lists four files —
`herald-watch.service`, `herald-x-reconcile.service`, `herald-x-reconcile.timer`,
`herald-notify-failure@.service` — but a working install needs seven: `herald-watch.timer` and both
`herald-convert.*` are missing, documented only by a prose aside in the convert section ("설치는
`herald-watch`와 같습니다 — 파일 이름만 바꿔 복사"). Someone following the block verbatim installs a
watch service with no timer. Replace it with the full list, now nine files:

```bash
cp deploy/herald-watch.service deploy/herald-watch.timer \
   deploy/herald-convert.service deploy/herald-convert.timer \
   deploy/herald-x-reconcile.service deploy/herald-x-reconcile.timer \
   deploy/herald-creds.service deploy/herald-creds.timer \
   deploy/herald-notify-failure@.service \
   ~/.config/systemd/user/
rm -f ~/.config/systemd/user/herald-notify-failure.service   # 템플릿과 같이 두면 안 됩니다
systemctl --user daemon-reload
```

Keep whatever prose around the block still reads true, and check the convert section's "same as
herald-watch" aside — if the block now lists convert explicitly, that aside should say so rather
than implying the reader must derive it.

Then add a short subsection after the x-reconcile one:

```markdown
### 크레덴셜 상시 점검 (herald-creds)

배포본의 크레덴셜이 **배포 사이에** 죽는 것을 잡습니다. `pnpm deploy:smoke`는 배포할 때만 보는데,
2026-08-10 사고는 배포 사이에 일어났습니다 — 배포본의 Google·Typefully·Telegram이 나흘간 401을
내는 동안 `deploy:check`는 40 ok로 통과했고 보드는 `availableTargets: google — present`라고 말하고
있었습니다.

매일 06:23에 배포본에 로그인해 `/api/diagnostics/live`를 읽고, 발행 크레덴셜이 죽어 있으면 종료
코드 1로 끝나 기존 텔레그램 훅이 알립니다. 발송 크레덴셜은 `HERALD_SENDS_ENABLED`가 꺼져 있는
동안 경고에 그치고, 시트도 경고입니다.

**`.env`에 `HERALD_SMOKE_USERNAME`과 `HERALD_SMOKE_PASSWORD`가 필요합니다** — 무인 실행이라
프롬프트를 띄울 수 없기 때문입니다. 이건 해시가 아니라 **대시보드 비밀번호 자체**이고,
`.env.example`이 이 용도를 허용하는 대신 **Vercel에는 절대 넣지 말라**고 못 박아 둔 값입니다.
없으면 이 명령은 프롬프트로 매달리지 않고 즉시 종료 코드 2로 거부합니다.

손으로 한 번 돌려 확인한 뒤 켜세요 — 아무것도 쓰지 않는 읽기 전용 명령입니다:

```bash
pnpm creds:check                                   # HERALD_DEPLOYMENT_ORIGIN을 씁니다
systemctl --user enable --now herald-creds.timer
```
```

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add deploy/herald-creds.service deploy/herald-creds.timer tests/deploy/credsTiming.test.ts docs/ko/team-runbook.md
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): check the deployment's credentials on a daily timer"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the shared client and its no-cookie-possible
property are Task 1; `deploy:smoke` sharing it is Task 2; the CLI, the `HERALD_DEPLOYMENT_ORIGIN`
fallback and the prompt-is-a-refusal rule are Task 3; the unit, the timer, the `:23` minute, the
absent `prod.env`, and the install docs are Task 4. The severity table is reused unchanged via
`checkLiveness` and asserted in Task 3's tests. The spec's "what this still does not fix" (the
machine being off) needs no code.

**A pre-existing gap found while checking Task 4's edit point, folded into it.** The runbook's
`cp … ~/.config/systemd/user/` block lists four unit files; a working install needs seven, and today
seven were installed by hand while the block still said four. `herald-watch.timer` and both
`herald-convert.*` are documented only by a prose aside elsewhere, so following the block verbatim
installs a watch service with no timer to fire it — a scheduler that looks installed and never runs,
which is this project's recurring failure shape. Task 4 replaces the block with the full nine.

**One interaction the spec did not anticipate, resolved in Task 2.**
`tests/deploy/smokeSession.test.ts` guards today's Critical by parsing `deploy-smoke.ts`'s source for
`{ headers: { cookie } }`. Extracting the client deletes that spelling, so the guard would fail for
the right reason and could be mistaken for an inconvenient test. Task 2 makes reading it a step of
its own and repoints it at the new invariant rather than dropping it.

**Types.** `DeploymentClient` and `createDeploymentClient` are defined in Task 1 and consumed with
the same signatures in Tasks 2 and 3. `checkLiveness(probes: unknown, sendsEnabled: boolean,
httpStatus?: number)` is used in Task 3 exactly as it exists on disk today — `probes` is `unknown` on
purpose, which is why Task 3 passes `liveBody?.probes` without narrowing it first.

**Placeholders:** none — every step carries the code or the command it needs.
