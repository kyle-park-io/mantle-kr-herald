# Deployed Credential Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `pnpm deploy:smoke` find out whether the deployment's credentials are actually alive, instead of only whether their environment variables exist.

**Architecture:** One shared probe module does the network work; `pnpm doctor --live` and a new authenticated route on the deployment both call it; `deploy:smoke` reads the route and maps the report onto pass/warn/fail by what each credential is for.

**Tech Stack:** TypeScript (ESM), tsx, Vitest, `fetch` with `AbortSignal.timeout`.

**Spec:** `docs/superpowers/specs/2026-08-10-deployed-credential-liveness-design.md`

## Global Constraints

- **Never put a credential in a probe's `detail`.** This is the load-bearing property: the module holds every live secret the deployment has, and its output crosses the network into a terminal and CI logs. The Telegram probe puts its bot token **in the URL**, so a thrown `fetch` error can carry the token inside `err.message` — redaction is a mechanism in the code, not a habit.
- **A probe never throws.** A diagnostic endpoint that dies when something is wrong is no diagnostic. Every failure becomes `status: "dead"` with a message.
- **Liveness only judges what is configured.** Absent config is `skipped` — neither fail nor warn. Presence is `deploy:check`'s job.
- Relative imports carry no file extension. The repo has ~1015 such imports and `pnpm build:api` bundles around it.
- CLI output is English. Korean stays for the dashboard and `docs/ko/`.
- git identity is missing on this machine — commit with `git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' commit …`.
- Work on branch `design/deployed-credential-liveness`, which already holds the spec commit `d5ca8b9`.
- Do not probe `twitterapi`. The deployment never collects and its key is deliberately absent.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/doctor/liveProbes.ts` (create) | Every live credential check, as one function over injected config and `fetch`. No config loading, no CLI formatting. |
| `tests/doctor/liveProbes.test.ts` (create) | The probes against an injected fetch, including the redaction property. |
| `src/cli/doctor.ts` (modify) | `--live` stops making its own calls and maps the module's results onto its existing labels. |
| `src/adapters/web/apiHandlers.ts` (modify) | `ApiDeps.probeLiveness`, and `GET /api/diagnostics/live`. |
| `src/app/createDeps.ts` (modify) | Builds `probeLiveness` from the loaders it already calls. |
| `tests/adapters/web/diagnosticsRoute.test.ts` (create) | The route: 200 with a report even when everything is dead; 401 anonymous. |
| `src/deploy/smokeChecks.ts` (modify) | `checkLiveness()` — report → `CheckResult[]`. |
| `src/cli/deploy-smoke.ts` (modify) | Fetches the route after login and pushes the results. |
| `tests/deploy/smokeChecks.test.ts` (modify) | The severity mapping. |

---

### Task 1: The probe module

**Files:**
- Create: `src/doctor/liveProbes.ts`
- Test: `tests/doctor/liveProbes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ProbeStatus = "ok" | "dead" | "skipped"`
  - `interface LiveProbeResult { key: string; status: ProbeStatus; detail: string }`
  - `interface LiveProbeInput { googleToken?: () => Promise<string>; googleDrive?: { reviewFolderId: string; approvedFolderId: string }; googleSheetId?: string; lark?: { appId: string; appSecret: string; baseUrl: string }; typefully?: { apiKey: string; socialSetId: string }; telegramBotToken?: string }`
  - `runLiveProbes(input: LiveProbeInput, fetchFn?: typeof fetch, timeoutMs?: number): Promise<LiveProbeResult[]>` — results in the fixed order `google_auth, google_drive, google_sheets, lark, typefully, telegram`

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/liveProbes.test.ts`:

```ts
// tests/doctor/liveProbes.test.ts
//
// These probes are the only thing that can tell a live credential from a present one, and they run
// in two places: `pnpm doctor --live` on an operator's machine, and inside the deployment behind
// `GET /api/diagnostics/live`. The deployment case is why the redaction test at the bottom is the
// most important one here — the module holds every live secret the function has, and its output
// travels back over the network into a terminal and a CI log.
//
// The Telegram probe is the sharp edge: its bot token goes in the URL path, so a thrown fetch error
// can carry the token inside `err.message` without anyone writing it there on purpose.
import { describe, it, expect } from "vitest";
import { runLiveProbes, type LiveProbeInput, type LiveProbeResult } from "../../src/doctor/liveProbes";

const ok = (body: unknown = {}): Response => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number): Response => new Response("{}", { status: code });

/** Every probe configured, with values distinctive enough to spot if one ever leaks. */
const SECRETS = {
  larkSecret: "lark-secret-ZZZZZZZZZZZZ",
  typefullyKey: "tf-key-YYYYYYYYYYYYYYYY",
  telegramToken: "1234567890:AAH-telegram-token-XXXXXXXXXXXX",
};

function fullInput(overrides: Partial<LiveProbeInput> = {}): LiveProbeInput {
  return {
    googleToken: async () => "ya29.access-token-WWWWWWWW",
    googleDrive: { reviewFolderId: "revfolder", approvedFolderId: "appfolder" },
    googleSheetId: "sheet123",
    lark: { appId: "cli_app", appSecret: SECRETS.larkSecret, baseUrl: "https://open.larksuite.com" },
    typefully: { apiKey: SECRETS.typefullyKey, socialSetId: "283589" },
    telegramBotToken: SECRETS.telegramToken,
    ...overrides,
  };
}

const byKey = (rs: LiveProbeResult[], key: string): LiveProbeResult => {
  const r = rs.find((x) => x.key === key);
  expect(r, `no result for ${key}`).toBeDefined();
  return r as LiveProbeResult;
};

describe("runLiveProbes", () => {
  it("reports every probe ok when each call succeeds", async () => {
    const results = await runLiveProbes(fullInput(), async () => ok({ code: 0, tenant_access_token: "t" }));
    expect(results.map((r) => r.key)).toEqual(["google_auth", "google_drive", "google_sheets", "lark", "typefully", "telegram"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("skips a probe whose config is absent, rather than failing it", async () => {
    // A Telegram-only install must not go red because Lark Drive is not set up.
    const results = await runLiveProbes({}, async () => ok());
    expect(results.every((r) => r.status === "skipped")).toBe(true);
  });

  it("marks a probe dead on a non-2xx, carrying the status code", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("typefully") ? status(401) : ok({ code: 0 }),
    );
    expect(byKey(results, "typefully").status).toBe("dead");
    expect(byKey(results, "typefully").detail).toContain("401");
  });

  it("marks a probe dead when fetch throws, instead of propagating", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("telegram")) throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
      return ok({ code: 0 });
    });
    expect(byKey(results, "telegram").status).toBe("dead");
    expect(byKey(results, "telegram").detail).toContain("ENOTFOUND");
  });

  it("marks Google auth dead when the token cannot be refreshed", async () => {
    const results = await runLiveProbes(
      fullInput({ googleToken: async () => { throw new Error("Google OAuth token refresh failed: HTTP 400"); } }),
      async () => ok({ code: 0 }),
    );
    expect(byKey(results, "google_auth").status).toBe("dead");
    expect(byKey(results, "google_auth").detail).toContain("400");
  });

  it("does not claim Drive and Sheets are dead on their own merits when the token never came", async () => {
    // They were never reached. Saying "folder unreachable" would send the operator after a folder id
    // that is fine — the same mis-blame tests/doctor/checks.test.ts already guards for the Sheet 404.
    const results = await runLiveProbes(
      fullInput({ googleToken: async () => { throw new Error("refresh failed"); } }),
      async () => ok({ code: 0 }),
    );
    for (const key of ["google_drive", "google_sheets"]) {
      expect(byKey(results, key).status).toBe("dead");
      expect(byKey(results, key).detail).toMatch(/token/i);
    }
  });

  it("reports Lark dead when the API answers 200 with a non-zero code", async () => {
    // Lark signals failure in the body, not the status line.
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("larksuite") ? ok({ code: 10003, msg: "invalid app_secret" }) : ok({ code: 0 }),
    );
    expect(byKey(results, "lark").status).toBe("dead");
    expect(byKey(results, "lark").detail).toContain("10003");
  });

  // The load-bearing test of this file.
  it("never puts a credential in any detail, even when the error message contains one", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      // Mirrors what a real failure looks like: the message quotes the whole URL, and the Telegram
      // bot token is IN that URL.
      throw new Error(`request to ${String(url)} failed`);
    });
    const all = results.map((r) => r.detail).join("\n");
    for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
    expect(all).not.toContain("ya29.access-token-WWWWWWWW");
    // And it still says something useful rather than swallowing the error.
    expect(byKey(results, "telegram").detail.length).toBeGreaterThan(0);
  });

  it("bounds each call with the given timeout", async () => {
    let seen: AbortSignal | undefined;
    await runLiveProbes(fullInput({ googleToken: undefined, googleDrive: undefined, googleSheetId: undefined, lark: undefined, typefully: undefined }),
      async (_url, init) => { seen = (init as RequestInit | undefined)?.signal ?? undefined; return ok(); }, 1234);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/doctor/liveProbes.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/liveProbes"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/doctor/liveProbes.ts`:

```ts
/**
 * Does each configured credential still work — not merely exist. `deploy:check` can only read
 * variable NAMES (`--sensitive` values cannot be read back at all), and the deployment's own status
 * payload reports presence by construction (`createDeps.ts`: "env only, no live calls"), so this is
 * the only thing in the repo that can tell a revoked token from a live one.
 *
 * Runs in two places from one copy: `pnpm doctor --live` locally, and inside the deployment behind
 * `GET /api/diagnostics/live`. A second implementation would drift from the first, and the drifted
 * one would be the copy running in production.
 *
 * Config comes in already loaded — this module never reads `process.env`. That keeps it honest
 * under test and lets the caller decide what "configured" means.
 */

export type ProbeStatus = "ok" | "dead" | "skipped";

export interface LiveProbeResult {
  key: string;
  status: ProbeStatus;
  /** Human-readable, English, and — enforced below — never containing a credential. */
  detail: string;
}

export interface LiveProbeInput {
  /** Refreshes an access token. Absent when Google auth is not configured. */
  googleToken?: () => Promise<string>;
  googleDrive?: { reviewFolderId: string; approvedFolderId: string };
  googleSheetId?: string;
  lark?: { appId: string; appSecret: string; baseUrl: string };
  typefully?: { apiKey: string; socialSetId: string };
  telegramBotToken?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const skipped = (key: string, why: string): LiveProbeResult => ({ key, status: "skipped", detail: `not configured — ${why}` });
const dead = (key: string, detail: string): LiveProbeResult => ({ key, status: "dead", detail });
const alive = (key: string, detail: string): LiveProbeResult => ({ key, status: "ok", detail });

/**
 * Replaces every secret with `***`. Not belt-and-braces: the Telegram probe puts its bot token in
 * the URL path, and `fetch`'s own errors quote the URL, so without this a network blip publishes the
 * token into a terminal and a CI log. Short values are left alone — redacting a 3-character string
 * would blank out unrelated text and hide the actual error.
 */
function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/** A probe never throws: a diagnostic that dies when something is wrong is no diagnostic. */
async function attempt(
  key: string,
  secrets: readonly (string | undefined)[],
  run: () => Promise<LiveProbeResult>,
): Promise<LiveProbeResult> {
  try {
    return await run();
  } catch (err) {
    return dead(key, redact(err instanceof Error ? err.message : String(err), secrets));
  }
}

export async function runLiveProbes(
  input: LiveProbeInput,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LiveProbeResult[]> {
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs);

  // Google first and alone: Drive and Sheets both need the token this produces, so they cannot run
  // in parallel with it. Everything after this point does.
  let token: string | undefined;
  const googleAuth = input.googleToken
    ? await attempt("google_auth", [], async () => {
        token = await input.googleToken!();
        return alive("google_auth", "token refreshed");
      })
    : skipped("google_auth", "no Google OAuth credentials");

  const googleDrive = async (): Promise<LiveProbeResult> => {
    if (!input.googleDrive) return skipped("google_drive", "GDRIVE_REVIEW_FOLDER_ID / GDRIVE_APPROVED_FOLDER_ID unset");
    if (!token) return dead("google_drive", "not checked — the Google token could not be refreshed");
    for (const [label, id] of [
      ["review", input.googleDrive.reviewFolderId],
      ["approved", input.googleDrive.approvedFolderId],
    ] as const) {
      const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal(),
      });
      if (!res.ok) return dead("google_drive", `${label} folder unreachable — HTTP ${res.status}`);
    }
    return alive("google_drive", "review and approved folders reachable");
  };

  const googleSheets = async (): Promise<LiveProbeResult> => {
    if (!input.googleSheetId) return skipped("google_sheets", "GSHEET_ID unset");
    if (!token) return dead("google_sheets", "not checked — the Google token could not be refreshed");
    const res = await fetchFn(
      `https://sheets.googleapis.com/v4/spreadsheets/${input.googleSheetId}?fields=spreadsheetId`,
      { headers: { Authorization: `Bearer ${token}` }, signal: signal() },
    );
    return res.ok ? alive("google_sheets", "spreadsheet reachable") : dead("google_sheets", `HTTP ${res.status}`);
  };

  const lark = async (): Promise<LiveProbeResult> => {
    if (!input.lark) return skipped("lark", "LARK_APP_ID / LARK_APP_SECRET unset");
    const res = await fetchFn(`${input.lark.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: input.lark.appId, app_secret: input.lark.appSecret }),
      signal: signal(),
    });
    if (!res.ok) return dead("lark", `HTTP ${res.status}`);
    // Lark answers 200 with a non-zero `code` for a bad secret — the status line alone would pass.
    const body = (await res.json()) as { code?: number; msg?: string };
    return body.code === 0
      ? alive("lark", "tenant token issued")
      : dead("lark", `Lark code ${body.code} — ${body.msg ?? "no message"}`);
  };

  const typefully = async (): Promise<LiveProbeResult> => {
    if (!input.typefully) return skipped("typefully", "TYPEFULLY_API_KEY / TYPEFULLY_SOCIAL_SET_ID unset");
    const res = await fetchFn(`https://api.typefully.com/v2/social-sets/${input.typefully.socialSetId}/`, {
      headers: { Authorization: `Bearer ${input.typefully.apiKey}` },
      signal: signal(),
    });
    return res.ok ? alive("typefully", "social set reachable") : dead("typefully", `HTTP ${res.status}`);
  };

  const telegram = async (): Promise<LiveProbeResult> => {
    if (!input.telegramBotToken) return skipped("telegram", "TELEGRAM_BOT_TOKEN unset");
    // getMe validates the token and sends nothing. The token is in the path — see `redact`.
    const res = await fetchFn(`https://api.telegram.org/bot${input.telegramBotToken}/getMe`, { signal: signal() });
    return res.ok ? alive("telegram", "bot token valid") : dead("telegram", `HTTP ${res.status}`);
  };

  const secrets = [input.lark?.appSecret, input.typefully?.apiKey, input.telegramBotToken, token];
  const rest = await Promise.all([
    attempt("google_drive", secrets, googleDrive),
    attempt("google_sheets", secrets, googleSheets),
    attempt("lark", secrets, lark),
    attempt("typefully", secrets, typefully),
    attempt("telegram", secrets, telegram),
  ]);

  return [googleAuth, ...rest];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/doctor/liveProbes.test.ts` — expect 9 passed.
Then `pnpm typecheck` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/liveProbes.ts tests/doctor/liveProbes.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(doctor): probe credentials for liveness in one shared module"
```

---

### Task 2: `doctor --live` calls the module

Behaviour-preserving. The point is that there is one copy of "is this token alive", and it is the copy the deployment runs.

**Files:**
- Modify: `src/cli/doctor.ts:131-182` (the `if (live)` block)

**Interfaces:**
- Consumes: `runLiveProbes`, `LiveProbeResult` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Capture the current output as the thing to preserve**

Run against the real environment and save it:

```bash
pnpm doctor --live 2>/dev/null | grep "live" > /tmp/doctor-live-before.txt
cat /tmp/doctor-live-before.txt
```

This is the baseline. The block below must produce the same *set of check names*, in the same order.

- [ ] **Step 2: Replace the block's network calls with the module**

In `src/cli/doctor.ts`, the `if (live)` block keeps its config loading and its labels, and delegates the calls. Replace the body of the Google `try` (lines 132-176) plus the Lark and Typefully live checks with:

```ts
  const probeInput: LiveProbeInput = {};
  try {
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    probeInput.googleToken = () => auth.getToken();
  } catch {
    /* not configured — the offline check already reported it, and the probe reports skipped */
  }
  try {
    const g = loadGoogleDriveConfig();
    probeInput.googleDrive = { reviewFolderId: g.reviewFolderId, approvedFolderId: g.approvedFolderId };
  } catch {
    /* same */
  }
  try {
    probeInput.googleSheetId = loadGoogleSheetConfig().spreadsheetId;
  } catch {
    /* same */
  }
  try {
    // `loadLarkAppConfig`, NOT `loadLarkConfig`: the latter also requires LARK_CHAT_IDS, which is a
    // collection variable deliberately absent from the deployment. Using it here would make the Lark
    // probe report `skipped` on every hosted run — the check quietly never running is the failure
    // this whole plan exists to remove.
    const l = loadLarkAppConfig();
    probeInput.lark = { appId: l.appId, appSecret: l.appSecret, baseUrl: l.baseUrl };
  } catch {
    /* same */
  }
  try {
    const t = loadTypefullyConfig();
    probeInput.typefully = { apiKey: t.apiKey, socialSetId: t.socialSetId };
  } catch {
    /* same */
  }
  probeInput.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;

  const LIVE_LABELS: Record<string, string> = {
    google_auth: "Google auth  live",
    google_drive: "Google Drive  live",
    google_sheets: "Google Sheet file  live",
    lark: "Lark  live",
    typefully: "Typefully  live",
    telegram: "Telegram  live",
  };
  for (const probe of await runLiveProbes(probeInput)) {
    results.push({
      name: LIVE_LABELS[probe.key] ?? probe.key,
      status: probe.status === "ok" ? "ok" : probe.status === "skipped" ? "warn" : "fail",
      detail: probe.detail,
    });
  }
```

Add the imports at the top of the file:

```ts
import { runLiveProbes, type LiveProbeInput } from "../doctor/liveProbes";
```

Remove imports that the deleted code was the only user of — run `pnpm typecheck` and let it name them.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: green. `tests/doctor/checks.test.ts` still passes — `scopeCheck`, `accessResult` and `sheetAccessResult` keep their own tests even where `doctor.ts` no longer calls them.

- [ ] **Step 4: Compare against the baseline**

```bash
pnpm doctor --live 2>/dev/null | grep "live" > /tmp/doctor-live-after.txt
diff /tmp/doctor-live-before.txt /tmp/doctor-live-after.txt || true
```

Details will differ — the wording comes from the module now. **Report the diff in full rather than judging it yourself:** the check names present and their ok/warn/fail verdicts must match the baseline, and a scope check that disappeared is a real loss to raise, not a wording change to wave through.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "refactor(doctor): run --live through the shared probe module"
```

---

### Task 3: `GET /api/diagnostics/live`

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts` (`ApiDeps`, and the dispatch in `handleApi`)
- Modify: `src/app/createDeps.ts` (build `probeLiveness`)
- Test: `tests/adapters/web/diagnosticsRoute.test.ts` (create)

**Interfaces:**
- Consumes: `runLiveProbes`, `LiveProbeResult` from Task 1.
- Produces: `ApiDeps.probeLiveness: () => Promise<LiveProbeResult[]>`, and the route answering `{ probes: LiveProbeResult[] }` with status 200.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/web/diagnosticsRoute.test.ts`:

```ts
// tests/adapters/web/diagnosticsRoute.test.ts
//
// The route exists because liveness is observable from exactly one place — inside the deployment,
// where the credential is. Two properties matter and neither is obvious from the handler:
// it answers 200 with a report even when every probe is dead (a diagnostic that 500s when something
// is wrong tells you nothing), and it is behind the session like every route but login.
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../src/adapters/web/apiHandlers";
import type { LiveProbeResult } from "../../src/doctor/liveProbes";
import { fakeApiDeps } from "../support/fakeApiDeps";

const ALL_DEAD: LiveProbeResult[] = [
  { key: "google_auth", status: "dead", detail: "Google OAuth token refresh failed: HTTP 400" },
  { key: "telegram", status: "skipped", detail: "not configured — TELEGRAM_BOT_TOKEN unset" },
];

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return { ...fakeApiDeps(), probeLiveness: async () => ALL_DEAD, ...overrides } as ApiDeps;
}

describe("GET /api/diagnostics/live", () => {
  it("answers 200 with the report even when a probe is dead", async () => {
    const res = await handleApi(deps(), "GET", "/api/diagnostics/live", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ probes: ALL_DEAD });
  });

  it("requires a session", async () => {
    const res = await handleApi(deps({ session: undefined }), "GET", "/api/diagnostics/live", undefined);
    expect(res.status).toBe(401);
  });

  it("does not answer other methods", async () => {
    const res = await handleApi(deps(), "POST", "/api/diagnostics/live", undefined);
    expect(res.status).toBe(404);
  });
});
```

If `tests/support/fakeApiDeps.ts` has no `probeLiveness`, add one returning `[]` so every other test that builds deps keeps compiling.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/adapters/web/diagnosticsRoute.test.ts`
Expected: FAIL — the route answers 404 and `probeLiveness` is not on `ApiDeps`.

- [ ] **Step 3: Add the dependency and the route**

In `src/adapters/web/apiHandlers.ts`, add to `ApiDeps`:

```ts
  /**
   * Runs the live credential probes inside this deployment and reports what it found. Present on
   * both route sets: the check is about credentials, not about where the process happens to run,
   * and having it locally means `pnpm serve` exercises the same route in development.
   */
  probeLiveness: () => Promise<LiveProbeResult[]>;
```

with the import:

```ts
import type { LiveProbeResult } from "../../doctor/liveProbes";
```

Then in `handleApi`, after the session gate and beside the other GET routes:

```ts
  // Deliberately NOT a field on /api/status: the dashboard calls that on every load, and
  // `createDeps`'s "env only, no live calls" is a property worth keeping rather than an accident.
  // Six external calls per board render would be a different bug.
  if (method === "GET" && segments[1] === "diagnostics" && segments[2] === "live" && segments.length === 3) {
    return { status: 200, json: { probes: await deps.probeLiveness() } };
  }
```

In `src/app/createDeps.ts`, build it next to `integrations` (which loads the same config), and pass it into the returned deps:

```ts
  /** Live credential checks — the counterpart to `integrations` above, which only reports presence. */
  const probeLiveness = async (): Promise<LiveProbeResult[]> => {
    const input: LiveProbeInput = {};
    try {
      const auth = await createGoogleAuth(loadGoogleAuthConfig());
      input.googleToken = () => auth.getToken();
    } catch {
      /* not configured — the probe reports skipped */
    }
    try {
      const g = loadGoogleDriveConfig();
      input.googleDrive = { reviewFolderId: g.reviewFolderId, approvedFolderId: g.approvedFolderId };
    } catch {
      /* same */
    }
    try {
      input.googleSheetId = loadGoogleSheetConfig().spreadsheetId;
    } catch {
      /* same */
    }
    try {
      // `loadLarkAppConfig`, NOT `loadLarkConfig` — see Task 2's note: the latter requires
      // LARK_CHAT_IDS, which the deployment deliberately does not have, so it would make this probe
      // report `skipped` on every hosted run.
      const l = loadLarkAppConfig();
      input.lark = { appId: l.appId, appSecret: l.appSecret, baseUrl: l.baseUrl };
    } catch {
      /* same */
    }
    try {
      const t = loadTypefullyConfig();
      input.typefully = { apiKey: t.apiKey, socialSetId: t.socialSetId };
    } catch {
      /* same */
    }
    input.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
    return runLiveProbes(input);
  };
```

and add `probeLiveness,` to the object `createDeps` returns, beside `integrations`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/adapters/web/ && pnpm typecheck`
Expected: the three new cases pass and no existing web test breaks.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/apiHandlers.ts src/app/createDeps.ts tests/adapters/web/diagnosticsRoute.test.ts tests/support/fakeApiDeps.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(web): expose a session-gated credential liveness route"
```

---

### Task 4: `deploy:smoke` judges the report

**Files:**
- Modify: `src/deploy/smokeChecks.ts` (add `checkLiveness`)
- Modify: `src/cli/deploy-smoke.ts` (fetch the route, push the results)
- Modify: `tests/deploy/smokeChecks.test.ts`

**Interfaces:**
- Consumes: `LiveProbeResult` from Task 1; the route from Task 3.
- Produces: `checkLiveness(probes: LiveProbeResult[] | undefined, sendsEnabled: boolean): CheckResult[]`

- [ ] **Step 1: Write the failing test**

Append to `tests/deploy/smokeChecks.test.ts`:

```ts
import { checkLiveness } from "../../src/deploy/smokeChecks";
import type { LiveProbeResult } from "../../src/doctor/liveProbes";

const probe = (key: string, status: LiveProbeResult["status"]): LiveProbeResult => ({ key, status, detail: `${key} ${status}` });

describe("checkLiveness", () => {
  it("passes everything when every probe is ok", () => {
    const rs = checkLiveness([probe("google_auth", "ok"), probe("telegram", "ok")], false);
    expect(rs.every((r) => r.status === "ok")).toBe(true);
  });

  it("fails a dead publishing credential — that is what this deployment is for", () => {
    for (const key of ["google_auth", "google_drive", "lark"]) {
      const rs = checkLiveness([probe(key, "dead")], false);
      expect(rs[0].status, key).toBe("fail");
    }
  });

  it("warns on a dead send credential while sends are closed", () => {
    for (const key of ["telegram", "typefully"]) {
      expect(checkLiveness([probe(key, "dead")], false)[0].status, key).toBe("warn");
    }
  });

  it("fails the same credential once sends are open", () => {
    // The flag comes from the same status payload, so the check tightens exactly when sends open
    // rather than on a second decision someone has to remember.
    for (const key of ["telegram", "typefully"]) {
      expect(checkLiveness([probe(key, "dead")], true)[0].status, key).toBe("fail");
    }
  });

  it("only ever warns about the Sheet — it is header links", () => {
    expect(checkLiveness([probe("google_sheets", "dead")], true)[0].status).toBe("warn");
  });

  it("treats an unconfigured probe as ok, never as a failure", () => {
    // Presence is deploy:check's job. A Telegram-only install must not go red over Lark Drive.
    const rs = checkLiveness([probe("lark", "skipped"), probe("typefully", "skipped")], true);
    expect(rs.every((r) => r.status === "ok")).toBe(true);
  });

  it("fails loudly when the route could not be read at all", () => {
    // Distinguished from "everything passed": a deployment too old to have the route, or one
    // answering 500, must not read as a clean bill of health.
    const rs = checkLiveness(undefined, false);
    expect(rs).toHaveLength(1);
    expect(rs[0].status).toBe("fail");
    expect(rs[0].detail).toMatch(/diagnostics/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/smokeChecks.test.ts`
Expected: FAIL — `checkLiveness is not a function`.

- [ ] **Step 3: Implement**

Append to `src/deploy/smokeChecks.ts`:

```ts
/**
 * Severity by what the credential is for, not by which API answered. Publishing is what this
 * deployment exists to do, so a dead publish credential fails; sends ship closed and follow the flag
 * the same status payload already carries; the Sheet is header links.
 *
 * `skipped` is ok, never a failure — presence is `deploy:check`'s job, and a Telegram-only install
 * must not go red because Lark Drive is absent. Same split `requirements.ts` draws, same reason.
 */
const PUBLISH_KEYS = ["google_auth", "google_drive", "lark"] as const;
const SEND_KEYS = ["telegram", "typefully"] as const;

export function checkLiveness(probes: LiveProbeResult[] | undefined, sendsEnabled: boolean): CheckResult[] {
  if (probes === undefined) {
    return [
      {
        name: "credential liveness",
        status: "fail",
        detail:
          "GET /api/diagnostics/live could not be read — an old deployment without the route, or one answering an error. " +
          "Not the same as every credential being alive, so this is a failure rather than a pass.",
      },
    ];
  }
  return probes.map((probe) => {
    const name = `live: ${probe.key}`;
    if (probe.status === "ok") return { name, status: "ok" as const, detail: probe.detail };
    if (probe.status === "skipped") return { name, status: "ok" as const, detail: probe.detail };
    const severity: CheckResult["status"] = (PUBLISH_KEYS as readonly string[]).includes(probe.key)
      ? "fail"
      : (SEND_KEYS as readonly string[]).includes(probe.key) && sendsEnabled
        ? "fail"
        : "warn";
    return { name, status: severity, detail: probe.detail };
  });
}
```

with the import at the top of the file:

```ts
import type { LiveProbeResult } from "../doctor/liveProbes";
```

- [ ] **Step 4: Wire it into the command**

In `src/cli/deploy-smoke.ts`, after `results.push(...checkStatus(payload));` (line 137), add:

```ts
// The one thing checkStatus cannot tell you: whether the credentials behind those `present` flags
// still work. Read through the same session the status call used.
const liveRes = await request("/api/diagnostics/live");
const probes =
  liveRes && liveRes.ok ? ((await liveRes.json()) as { probes?: LiveProbeResult[] }).probes : undefined;
results.push(...checkLiveness(probes, payload !== null && typeof payload === "object" && (payload as { sendsEnabled?: boolean }).sendsEnabled === true));
```

and extend the existing import from `../deploy/smokeChecks` with `checkLiveness`, plus:

```ts
import type { LiveProbeResult } from "../doctor/liveProbes";
```

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 6: Verify against the real deployment**

```bash
pnpm deploy:smoke https://mantle-kr-herald.vercel.app
```

Expect new `live: …` lines. **This is the acceptance test for the whole plan** — before this change the same command reported `availableTargets: google — present` for a token that had been dead for minutes. Report the live lines verbatim.

- [ ] **Step 7: Commit**

```bash
git add src/deploy/smokeChecks.ts src/cli/deploy-smoke.ts tests/deploy/smokeChecks.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): fail the smoke check on a dead deployed credential"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the shared module and its six probes are Task 1; `doctor --live` sharing it is Task 2; the route, its 200-on-failure rule, session gate and both route sets are Task 3; the severity table, the `skipped`-is-not-a-failure rule and the `sendsEnabled` flip are Task 4. The redaction property is Task 1's load-bearing test. The spec's "not probed: twitterapi" is honoured by its absence from `LiveProbeInput`.

**Two gaps found and closed while reviewing.**

*The route cannot be read at all* — an older deployment, or one answering 500. The spec is silent, and silence would make `checkLiveness([])` and "no route" both look like a pass: the exact false clean bill this plan exists to remove. Task 4 handles `undefined` as a `fail` and tests it.

*The wrong Lark loader.* The first draft used `loadLarkConfig()`, which also requires `LARK_CHAT_IDS` — a collection variable the deployment deliberately does not set (`docs/ko/setup/vercel.md` §4). The Lark probe would have reported `skipped` on every hosted run: a check that silently never runs, which is worse than no check, because the report would say so in green. Both call sites now use `loadLarkAppConfig()`, whose own doc comment is "App credentials + base URL only (no chat ids)" and whose return type matches `LiveProbeInput.lark` exactly.

**Types.** `LiveProbeResult`, `ProbeStatus` and `LiveProbeInput` are defined in Task 1 and consumed unchanged in Tasks 2-4. `probeLiveness: () => Promise<LiveProbeResult[]>` is declared in Task 3 and used with that exact signature by Task 4's route call. `checkLiveness(probes, sendsEnabled)` keeps its two-argument shape at its only call site.

**Placeholders:** none — every step carries the code it needs.
