# Deploy scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm deploy:check` refuses a Vercel deploy that would land wrong; `pnpm deploy:smoke <url>` proves the one that landed is right.

**Architecture:** Judgement is pure and tested; transport is thin and read. Two modules under `src/deploy/` hold every expectation and every verdict as functions over plain data. Two entry points under `src/cli/` gather the data (subprocess, HTTP, prompt) and hand it to those functions. Reporting reuses `src/doctor/report.ts` so all three commands print the same way.

**Tech Stack:** TypeScript, `tsx`, vitest. No new dependencies — `node:child_process` for the Vercel CLI and `pnpm doctor`, `fetch` for HTTP, and the existing `src/cli/prompt.ts` for the password.

**Spec:** `docs/superpowers/specs/2026-08-04-deploy-scripts-design.md`

## Global Constraints

- Never read a Vercel environment **value**. Names only, via `vercel env ls --json`. The spec's reasoning is in "The gap neither command closes"; violating this puts production secrets on disk.
- Never send. No outlet route is called by either command.
- The password is read from a prompt, never an argument or an environment variable — same rule as `pnpm auth:hash`.
- Reuse `CheckResult` / `formatReport` from `src/doctor/report.ts`. Do not define a second result shape.
- Korean output for anything an operator reads; English for code, comments, and commit messages.
- Exit code 1 when any check has status `fail`, matching `src/cli/doctor.ts`'s last two lines.

---

### Task 1: Environment-name expectations

**Files:**
- Create: `src/deploy/requirements.ts`
- Test: `tests/deploy/requirements.test.ts`

**Interfaces:**
- Consumes: `CheckResult`, `CheckStatus` from `src/doctor/report.ts`
- Produces:
  - `export interface EnvExpectation { name: string; severity: "fail" | "warn"; consequence: string }`
  - `export const MUST_BE_SET: readonly EnvExpectation[]`
  - `export const MUST_BE_ABSENT: readonly EnvExpectation[]`
  - `export function checkEnvNames(present: readonly string[]): CheckResult[]`

**Read first:** `.env.example` §6 (the two lists and how each one fails), `docs/ko/setup/vercel.md` §4, `src/doctor/report.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/deploy/requirements.test.ts
import { describe, it, expect } from "vitest";
import { checkEnvNames, MUST_BE_SET, MUST_BE_ABSENT } from "../../src/deploy/requirements";

/** Every name the hosted deployment refuses to start without, plus DATABASE_URL from Neon. */
const COMPLETE = [
  "DATABASE_URL", "HERALD_DB_ENV", "HERALD_STORAGE_MODE",
  "HERALD_AUTH_USERNAME", "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET",
  "HERALD_TRUST_PROXY", "HERALD_DEPLOYMENT_ORIGIN",
  "GOOGLE_AUTH_MODE", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN", "GDRIVE_REVIEW_FOLDER_ID", "GDRIVE_APPROVED_FOLDER_ID",
  "GDRIVE_SENT_FOLDER_ID", "LARK_APP_ID", "LARK_APP_SECRET", "LARK_WORKSPACE_URL",
  "LARK_DRIVE_REVIEW_FOLDER_TOKEN", "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
  "LARK_DRIVE_SENT_FOLDER_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID_COMMUNITY",
  "TELEGRAM_CHAT_ID_DEV", "TYPEFULLY_API_KEY", "TYPEFULLY_SOCIAL_SET_ID",
  "X_PREMIUM", "GSHEET_ID", "GSHEET_QA_ID",
];

const statusOf = (results: ReturnType<typeof checkEnvNames>, needle: string) =>
  results.find((r) => r.name.includes(needle))?.status;

describe("checkEnvNames", () => {
  it("passes a complete production environment", () => {
    const results = checkEnvNames(COMPLETE);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.filter((r) => r.status === "warn")).toEqual([]);
  });

  // The eight that make the function refuse to start. Each is a fail, not a warning.
  it.each([
    "DATABASE_URL", "HERALD_DB_ENV", "HERALD_STORAGE_MODE", "HERALD_AUTH_USERNAME",
    "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET", "HERALD_TRUST_PROXY",
    "HERALD_DEPLOYMENT_ORIGIN",
  ])("fails when %s is missing", (name) => {
    const results = checkEnvNames(COMPLETE.filter((n) => n !== name));
    expect(statusOf(results, name)).toBe("fail");
  });

  // The ones that degrade in silence — a Telegram-only install is legitimate, so these warn.
  it.each(["GOOGLE_OAUTH_REFRESH_TOKEN", "GDRIVE_REVIEW_FOLDER_ID", "X_PREMIUM", "LARK_APP_ID"])(
    "warns rather than fails when %s is missing",
    (name) => {
      const results = checkEnvNames(COMPLETE.filter((n) => n !== name));
      expect(statusOf(results, name)).toBe("warn");
    },
  );

  it("names what stops working, not just that something is missing", () => {
    const results = checkEnvNames(COMPLETE.filter((n) => n !== "X_PREMIUM"));
    expect(results.find((r) => r.name.includes("X_PREMIUM"))?.detail).toMatch(/280/);
  });

  // A local path; the function has no such file. Present is a mistake, not a preference.
  it("fails when GOOGLE_SA_KEY_FILE is present", () => {
    expect(statusOf(checkEnvNames([...COMPLETE, "GOOGLE_SA_KEY_FILE"]), "GOOGLE_SA_KEY_FILE")).toBe("fail");
  });

  // The hosted board ships with sends closed; opening them is step 6, deliberately later.
  it("warns when HERALD_SENDS_ENABLED is already set", () => {
    expect(statusOf(checkEnvNames([...COMPLETE, "HERALD_SENDS_ENABLED"]), "HERALD_SENDS_ENABLED")).toBe("warn");
  });

  it("ignores the other variables Neon injects", () => {
    const results = checkEnvNames([...COMPLETE, "PGHOST", "POSTGRES_URL", "NEON_PROJECT_ID"]);
    expect(results.filter((r) => r.status !== "ok")).toEqual([]);
  });

  it("keeps the two lists disjoint", () => {
    const set = new Set(MUST_BE_SET.map((e) => e.name));
    expect(MUST_BE_ABSENT.filter((e) => set.has(e.name))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/deploy/requirements.test.ts`
Expected: FAIL — cannot resolve `../../src/deploy/requirements`.

- [ ] **Step 3: Implement to the invariants**

Invariants, not a shape to copy:

- `MUST_BE_SET` carries every name in the test's `COMPLETE`, each with the severity the tests assert and a `consequence` written for an operator: for `fail` entries, that the function will not start; for `warn` entries, what silently stops working. `X_PREMIUM`'s mentions the 280-weighted limit, because that string is asserted.
- `MUST_BE_ABSENT` carries `GOOGLE_SA_KEY_FILE` (fail) and `HERALD_SENDS_ENABLED` (warn).
- `checkEnvNames` returns one `CheckResult` per expectation and **nothing else** — unknown names present in the environment are not reported at all, which is what the Neon-injection test pins.
- Each result's `name` contains the variable name literally, because the entry point and the tests both locate results by substring.

Every `consequence` string traces to `.env.example` §6. Read it rather than inventing wording.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/deploy/requirements.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/deploy/requirements.ts tests/deploy/requirements.test.ts
git commit -m "feat(deploy): expectations for the Vercel production environment"
```

---

### Task 2: Smoke verdicts

**Files:**
- Create: `src/deploy/smokeChecks.ts`
- Test: `tests/deploy/smokeChecks.test.ts`

**Interfaces:**
- Consumes: `CheckResult` from `src/doctor/report.ts`
- Produces:
  - `export interface StatusPayload { storageMode?: string; dbEnv?: string; sendsEnabled?: boolean; conversionEnabled?: boolean; availableTargets?: string[]; integrations?: { label: string; configured: boolean }[] }`
  - `export function checkAnonymous(codes: { root: number; status: number; foreignOrigin: number; unknownPath: number }): CheckResult[]`
  - `export function checkLogin(code: number): CheckResult`
  - `export function checkStatus(payload: StatusPayload): CheckResult[]`
  - `export function checkConvertPrepare(code: number): CheckResult`
  - `export function checkLogout(statusCodeAfterLogout: number): CheckResult`

**Read first:** the spec's "`pnpm deploy:smoke <url>`" section, `src/adapters/web/apiHandlers.ts` (what `/api/status` actually returns), `src/app/createDeps.ts:102` (`sendsEnabled`) and `:110` (`conversionEnabled`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/deploy/smokeChecks.test.ts
import { describe, it, expect } from "vitest";
import {
  checkAnonymous, checkLogin, checkStatus, checkConvertPrepare, checkLogout,
  type StatusPayload,
} from "../../src/deploy/smokeChecks";

const HEALTHY: StatusPayload = {
  storageMode: "cloud",
  dbEnv: "production",
  sendsEnabled: false,
  conversionEnabled: false,
  availableTargets: ["local", "google", "lark"],
  integrations: [{ label: "Google Drive", configured: true }, { label: "Telegram", configured: true }],
};

const failures = (rs: CheckResultLike[]) => rs.filter((r) => r.status === "fail");
type CheckResultLike = { name: string; status: string; detail: string };

describe("checkAnonymous", () => {
  it("passes the shape a correct deployment answers with", () => {
    expect(failures(checkAnonymous({ root: 200, status: 401, foreignOrigin: 403, unknownPath: 200 }))).toEqual([]);
  });

  it("fails when the API answers an unauthenticated caller", () => {
    // 200 here means every route is open to the internet.
    expect(failures(checkAnonymous({ root: 200, status: 200, foreignOrigin: 403, unknownPath: 200 }))).not.toEqual([]);
  });

  it("fails when a foreign origin is not refused", () => {
    expect(failures(checkAnonymous({ root: 200, status: 401, foreignOrigin: 200, unknownPath: 200 }))).not.toEqual([]);
  });
});

describe("checkLogin", () => {
  it("passes on 200", () => {
    expect(checkLogin(200).status).toBe("ok");
  });

  // The whole reason deploy:check cannot verify HERALD_DEPLOYMENT_ORIGIN: this is where a wrong
  // one shows up, and the message has to say so or the operator will chase the password instead.
  it("blames HERALD_DEPLOYMENT_ORIGIN on 403", () => {
    const r = checkLogin(403);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/HERALD_DEPLOYMENT_ORIGIN/);
  });

  it("does not blame the origin on 401", () => {
    const r = checkLogin(401);
    expect(r.status).toBe("fail");
    expect(r.detail).not.toMatch(/HERALD_DEPLOYMENT_ORIGIN/);
  });
});

describe("checkStatus", () => {
  it("passes a healthy hosted deployment", () => {
    expect(failures(checkStatus(HEALTHY))).toEqual([]);
  });

  // The failure that shipped silently before `assertCloudStorage` existed.
  it("fails on local storage mode", () => {
    expect(failures(checkStatus({ ...HEALTHY, storageMode: "local" }))).not.toEqual([]);
  });

  it("fails when pointed at a development database", () => {
    expect(failures(checkStatus({ ...HEALTHY, dbEnv: "development" }))).not.toEqual([]);
  });

  it("fails when sends are already open", () => {
    expect(failures(checkStatus({ ...HEALTHY, sendsEnabled: true }))).not.toEqual([]);
  });

  it("fails when the hosted route set still offers conversion", () => {
    expect(failures(checkStatus({ ...HEALTHY, conversionEnabled: true }))).not.toEqual([]);
  });

  // Credentials missing: the deployment boots and quietly publishes nowhere but locally.
  it("fails when the google target is absent", () => {
    expect(failures(checkStatus({ ...HEALTHY, availableTargets: ["local"] }))).not.toEqual([]);
  });

  it("warns, not fails, when only lark is absent", () => {
    const rs = checkStatus({ ...HEALTHY, availableTargets: ["local", "google"] });
    expect(failures(rs)).toEqual([]);
    expect(rs.some((r) => r.status === "warn")).toBe(true);
  });

  it("reports an unconfigured integration by name", () => {
    const rs = checkStatus({
      ...HEALTHY,
      integrations: [{ label: "Google Drive", configured: false }, { label: "Telegram", configured: true }],
    });
    expect(rs.some((r) => r.detail.includes("Google Drive"))).toBe(true);
  });
});

describe("checkConvertPrepare", () => {
  it("wants a 404 — the route must be absent, not merely refusing", () => {
    expect(checkConvertPrepare(404).status).toBe("ok");
    expect(checkConvertPrepare(403).status).toBe("fail");
    expect(checkConvertPrepare(200).status).toBe("fail");
  });
});

describe("checkLogout", () => {
  it("wants 401 after the session is cleared", () => {
    expect(checkLogout(401).status).toBe("ok");
    expect(checkLogout(200).status).toBe("fail");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/deploy/smokeChecks.test.ts`
Expected: FAIL — cannot resolve `../../src/deploy/smokeChecks`.

- [ ] **Step 3: Implement to the invariants**

- Every function is total over its input and never throws: a malformed or absent field is a `fail` with a readable detail, not an exception. The entry point feeds these parsed JSON it did not validate.
- `checkStatus` treats a missing `google` target as `fail` and a missing `lark` target as `warn` — Google Drive is the record of truth in cloud mode, Lark is opt-in. The two tests above pin exactly this asymmetry.
- `checkLogin`'s 403 detail names `HERALD_DEPLOYMENT_ORIGIN`; no other code path mentions it, so the 401 test stays meaningful.
- Details are Korean and say what to do, in the register `src/doctor/report.ts` already prints.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/deploy/smokeChecks.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/deploy/smokeChecks.ts tests/deploy/smokeChecks.test.ts
git commit -m "feat(deploy): verdicts for a running hosted deployment"
```

---

### Task 3: `pnpm deploy:check`

**Files:**
- Create: `src/cli/deploy-check.ts`
- Modify: `package.json` (add the `deploy:check` script beside `doctor`)

**Interfaces:**
- Consumes: `checkEnvNames` (Task 1), `CheckResult`/`formatReport` from `src/doctor/report.ts`
- Produces: nothing other tasks import — an entry point.

**Read first:** `src/cli/doctor.ts` end to end (this file is its sibling and must feel like it, including the `process.exitCode = 1` ending), `tests/cli/serveStartupOrder.test.ts`'s doc comment for how this repo spawns real entry points.

Gathering, each fed into `checkEnvNames` or turned into a `CheckResult` directly:

- `git rev-parse --abbrev-ref HEAD` is `main`; `git status --porcelain` is empty **ignoring untracked files** (`DEPLOY.md` is deliberately untracked and must not fail the check); `git rev-list --count origin/main..HEAD` and `..origin/main` are both 0.
- `pnpm test` exits 0, unless `--skip-tests`, which prints that it skipped as a `warn`.
- `vercel env ls production --json` → the `key` of every entry → `checkEnvNames`.
- `vercel api /v9/projects/<projectId>` → `serverlessFunctionRegion` equals `vercel.json`'s `regions[0]`. Read the project id from `.vercel/project.json`; if that file is absent, fail with "run `npx vercel link`".
- `vercel api /v9/projects/<projectId>/domains` → print the first verified domain and state that `HERALD_DEPLOYMENT_ORIGIN` must equal `https://<that>`. This is informational (`ok`), never a comparison — the value cannot be read.
- `pnpm doctor --live` exits 0. Spawn it; do not reimplement it. Its own output is printed above this command's report.

Ends by printing `formatReport(results)` and setting `process.exitCode = 1` if any result failed.

- [ ] **Step 1: Write the entry point**

Follow the invariants above. `--skip-tests` is the only flag.

- [ ] **Step 2: Add the script**

In `package.json`, beside `"doctor"`:

```json
"deploy:check": "tsx --env-file-if-exists=.env src/cli/deploy-check.ts",
```

- [ ] **Step 3: Run it against the real project**

Run: `pnpm deploy:check --skip-tests`

Expected today, with step 3 of the runbook not yet done: `DATABASE_URL` ok; the seven `HERALD_*` names **fail**; the credential names **warn**; region check ok (`sin1` both sides); the domain line prints `mantle-kr-herald.vercel.app`; exit code 1.

Confirm the exit code: `pnpm deploy:check --skip-tests; echo $?` → `1`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/deploy-check.ts package.json
git commit -m "feat(deploy): pnpm deploy:check"
```

---

### Task 4: `pnpm deploy:smoke`

**Files:**
- Create: `src/cli/deploy-smoke.ts`
- Modify: `package.json` (add `deploy:smoke`)

**Interfaces:**
- Consumes: every export of `src/deploy/smokeChecks.ts` (Task 2), `ask` from `src/cli/prompt.ts`, `formatReport` from `src/doctor/report.ts`
- Produces: nothing other tasks import — an entry point.

**Read first:** `src/cli/prompt.ts` (its `ask(question, { hidden, input, output })` signature and why it exists), `src/adapters/web/HttpServer.ts`'s `refusalReason` for what the CSRF guard actually keys on, `tests/adapters/web/vercelHandler.test.ts` for the request shapes.

Transport invariants:

- Takes the deployment URL as the first argument. No argument is a usage error, exit 2.
- Sends `Origin: <the given url>` on every state-changing request, because the guard requires it. The foreign-origin probe sends `Origin: https://evil.example` and expects 403.
- Carries the session cookie from the login response through the authenticated requests, and stops carrying it after logout.
- Password via `ask(..., { hidden: true })`. Never an argument, never an environment variable.
- **Calls no outlet route.** The only POSTs are `/api/login`, `/api/logout`, and the `convert-prepare` probe, which is expected to 404.
- `--lockout` is opt-in and off by default: it sends five wrong passwords and expects 429. Without the flag, print a `warn` saying it was skipped and why (it locks the production dashboard for sixty seconds).

Ends with `formatReport` and the same exit-code rule.

- [ ] **Step 1: Write the entry point**

- [ ] **Step 2: Add the script**

```json
"deploy:smoke": "tsx --env-file-if-exists=.env src/cli/deploy-smoke.ts",
```

- [ ] **Step 3: Verify against a local hosted server, not production**

There is no deployment yet, and this must be exercised before it is trusted. `serve:hosted` answers the same routes through the same `createHandler`:

```bash
docker run -d --name herald-smoke -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=herald -p 5433:5432 postgres:16-alpine
cat > /tmp/smoke.env <<EOF
DATABASE_URL=postgres://postgres:smoke@127.0.0.1:5433/herald
HERALD_DB_ENV=production
HERALD_STORAGE_MODE=cloud
HERALD_SESSION_SECRET=$(openssl rand -hex 32)
HERALD_AUTH_USERNAME=smoke
EOF
# append HERALD_AUTH_PASSWORD_HASH from: printf 'smoke-test-1234' | pnpm auth:hash
npx tsx --env-file=/tmp/smoke.env src/cli/db-import.ts --yes
pnpm build:web
HERALD_TRUST_PROXY=true PORT=5758 npx tsx --env-file=/tmp/smoke.env src/cli/serve-hosted.ts
```

Then `pnpm deploy:smoke http://localhost:5758` in another terminal, password `smoke-test-1234`.

Expected: anonymous checks pass; login passes; `dbEnv` ok (`production`); `sendsEnabled` ok (closed); `conversionEnabled` ok (hosted); `convert-prepare` 404 ok; logout ok. `availableTargets` **fails on google** unless the Google variables are in `/tmp/smoke.env` — that failure is correct and demonstrates the check working.

Then flip one thing and confirm the check catches it: restart with `HERALD_STORAGE_MODE=local` and confirm the run reports the storage-mode failure rather than passing.

Clean up: `docker rm -f herald-smoke`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/deploy-smoke.ts package.json
git commit -m "feat(deploy): pnpm deploy:smoke"
```

---

### Task 5: Point the runbook at the commands

**Files:**
- Modify: `docs/ko/setup/vercel.md` (§4 and the 검증 section)
- Modify: `DEPLOY.md` if it is still in the tree — it is untracked on purpose, so edit it in place and do not add it to git.

**Read first:** `docs/ko/setup/vercel.md` in full — it declares itself the deployment SSOT, so the commands belong in it rather than in a new document.

- [ ] **Step 1: Replace the manual checklists with the commands**

Invariants:

- §4 ends by telling the reader to run `pnpm deploy:check` before deploying, and says it refuses rather than warns when a start-blocking variable is missing.
- The 검증 section's list becomes `pnpm deploy:smoke https://<domain>`, keeping the prose about what each item means — the list is what the command now checks, not a second copy of it.
- State that neither command can tell whether the deployed Google token is alive, with the one-line reason. Do not bury this.
- Keep §6's send-opening steps manual. They are not part of either command.

- [ ] **Step 2: Check the links resolve**

Run: `grep -oE '\]\([^)]+\.md[^)]*\)' docs/ko/setup/vercel.md` and confirm each target exists.

- [ ] **Step 3: Commit**

```bash
git add docs/ko/setup/vercel.md
git commit -m "docs(vercel): run deploy:check before, deploy:smoke after"
```

---

## Done when

- `pnpm deploy:check --skip-tests` exits 1 today and names every missing `HERALD_*`.
- `pnpm deploy:smoke http://localhost:5758` passes against a correctly configured local hosted server and fails against one started with `HERALD_STORAGE_MODE=local`.
- `pnpm test` green, `pnpm typecheck` clean.
