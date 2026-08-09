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

/**
 * Every key `runLiveProbes` can emit, and the only ones — see the fixed result order noted below.
 * `LiveProbeResult.key` is typed against this union (not a bare `string`) so that a caller
 * classifying probes by key, like `checkLiveness` in `src/deploy/smokeChecks.ts`, can be written as
 * an exhaustive `Record<ProbeKey, ...>`: adding a probe here without updating that map then fails
 * `pnpm typecheck` at the map, rather than silently defaulting to whatever that map's fallback does.
 */
export type ProbeKey =
  | "google_auth"
  | "google_drive_review"
  | "google_drive_approved"
  | "google_sheets"
  | "lark"
  | "typefully"
  | "telegram";

/**
 * Every string this carries, at any depth — `detail`, `grantedScopes`' entries, `resourceName`, and
 * `quota.resetsAt` — is guaranteed credential-free by construction: `attempt()` (below) walks the
 * whole result and redacts every string leaf before it leaves the module, not just `detail`. A field
 * added later gets this for free from the same walk; nothing here needs its own enforcement.
 *
 * Why the whole result and not just the human-readable line: a response body — a Drive folder's
 * `name`, Typefully's `resets_at`, Google's `tokeninfo` `scope` — is attacker-influenced input the
 * same way a thrown error's message is, and every field here is about to be serialised whole over the
 * network by the deployment (`GET /api/diagnostics/live`), not merely printed as a terminal line.
 */
export interface LiveProbeResult {
  key: ProbeKey;
  status: ProbeStatus;
  /** Human-readable, English. */
  detail: string;
  /** Google only: the scopes `tokeninfo` reported for the access token this probe obtained. */
  grantedScopes?: string[];
  /** The HTTP status a failed call actually answered with, so a caller can tell 403 from 404
   *  (`sheetAccessResult` in `src/doctor/checks.ts` needs exactly this — a 404 means two different
   *  things depending on whether the `spreadsheets` scope was granted). Absent when the probe never
   *  reached the network at all (not configured, or blocked on a token that never came). */
  httpStatus?: number;
  /** Typefully only, from the social-set response's `publishing_quota`. `limit` is `used + remaining`
   *  — the module doesn't forward `used` on its own, since the resend guard (`TypefullyQuota.ts`)
   *  treats "absent" and "zero" as different answers for that field and callers here don't need it
   *  raw, only combined into a total. */
  quota?: { remaining: number; limit: number; resetsAt?: string };
  /** Google Drive/Sheet only: the resource's own display name/title, when the response carried one.
   *  `accessResult`/`sheetAccessResult` (`src/doctor/checks.ts`) use it to name what was actually
   *  reached, not just that something was — restoring the same evidence the pre-module `doctor --live`
   *  showed (`accessible (review)`, not just `accessible`). */
  resourceName?: string;
}

export interface LiveProbeInput {
  /**
   * Refreshes an access token. Absent when Google auth is not configured.
   *
   * The `AbortSignal` is the run's own deadline, and a closure that reaches the network is expected
   * to forward it. Ignoring it is safe for the caller — `attempt()` bounds every probe regardless —
   * but only the signal can cancel the underlying socket, and an uncancelled one keeps a CLI from
   * exiting and a Vercel function running until the platform kills it.
   */
  googleToken?: (signal: AbortSignal) => Promise<string>;
  googleDrive?: { reviewFolderId: string; approvedFolderId: string };
  googleSheetId?: string;
  lark?: { appId: string; appSecret: string; baseUrl: string };
  typefully?: { apiKey: string; socialSetId: string };
  telegramBotToken?: string;
}

/**
 * The budget for a WHOLE `runLiveProbes` call, not for each request inside it. Per-request timeouts
 * were the previous meaning and they do not bound anything a caller can promise: Google auth ran
 * before the others and made two calls, Lark and Typefully make two each, so the real worst case was
 * 3× this number, and the one call that matters most — the caller-supplied `googleToken` closure —
 * had no bound at all (measured: still hanging at 6009 ms against a `timeoutMs` of 1000). The route
 * this module backs runs on Vercel with no `maxDuration` in `vercel.json`, so an unbounded hang
 * becomes a platform 504, which `checkLiveness` cannot tell apart from a deployment too old to have
 * the route. One deadline for the run is what makes the design doc's "answers in about five seconds
 * even when an external API is hanging" a property of the code rather than a hope.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A space-separated OAuth scope string → array (empties dropped). Duplicated from
 *  `src/doctor/checks.ts`'s own `parseScopes` rather than imported: that module pulls in `../config`
 *  and `../adapters/db/*` for its other exports, and this one is a leaf probe module that promises
 *  never to grow a database dependency just to parse a header. */
function parseScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((s) => s.length > 0);
}

type ProbeExtras = Partial<Pick<LiveProbeResult, "grantedScopes" | "httpStatus" | "quota" | "resourceName">>;

const skipped = (key: ProbeKey, why: string): LiveProbeResult => ({ key, status: "skipped", detail: `not configured — ${why}` });
const dead = (key: ProbeKey, detail: string, extras: ProbeExtras = {}): LiveProbeResult => ({ key, status: "dead", detail, ...extras });
const alive = (key: ProbeKey, detail: string, extras: ProbeExtras = {}): LiveProbeResult => ({ key, status: "ok", detail, ...extras });

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

/**
 * `redact()`, walked over every string leaf of a value — not just one named field. A probe result is
 * a plain JSON-shaped object (strings, numbers, an array of strings, one level of nesting for
 * `quota`), so a generic walk covers it completely: `detail` today, `grantedScopes`'s entries,
 * `resourceName`, `quota.resetsAt` — and whatever string field the next probe adds, without this
 * function or its caller needing to change. Naming fields one by one is exactly the shape of bug this
 * fixes: `attempt()` used to redact `result.detail` alone, and every sibling field went out unredacted.
 */
function redactDeep<T>(value: T, secrets: readonly (string | undefined)[]): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}

/** Thrown by `withDeadline` when the run's budget is spent. Its own class so `attempt()` can phrase
 *  a timeout as a timeout instead of leaking a generic message an operator has to decode. */
class DeadlineError extends Error {}

/**
 * True for the two shapes a spent budget arrives as: `DeadlineError` (this module gave up waiting on
 * something that does not take a signal), and the `DOMException` that `AbortSignal.timeout` aborts a
 * `fetch` with (`TimeoutError`, or `AbortError` on some runtimes). The only signal this module ever
 * passes anywhere is the deadline, so an abort here has exactly one cause.
 */
function isBudgetError(err: unknown): boolean {
  if (err instanceof DeadlineError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Rejects if `promise` has not settled within `ms`. The backstop half of the deadline: `signal()`
 * already bounds every `fetch` this module makes itself, but `input.googleToken` is a caller closure
 * this module cannot see inside, and `fetchFn` is injectable. Without this, one function that
 * ignores its signal holds the whole run — and therefore the route, and therefore `deploy:smoke` —
 * open indefinitely.
 *
 * The timer is deliberately NOT `unref`'d: a promise pending on nothing (the shape a hung closure
 * takes in a test) keeps no handle alive on its own, so an unref'd timer would let the process exit
 * before the report was ever printed.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`${what} did not answer within the budget`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A probe never throws: a diagnostic that dies when something is wrong is no diagnostic. */
async function attempt(
  key: ProbeKey,
  secrets: readonly (string | undefined)[],
  budget: { remainingMs: () => number; totalMs: number },
  run: () => Promise<LiveProbeResult>,
): Promise<LiveProbeResult> {
  try {
    const result = await withDeadline(run(), budget.remainingMs(), `the ${key} probe`);
    // Redact on the return path too, not only on throw. A Lark probe returning dead because its
    // 200-OK body has a non-zero code would leak a secret if the provider echoes back what was
    // sent (e.g., { code: 10003, msg: "invalid app_secret: <the-real-secret>" }). Returning is
    // as common a failure path as throwing, and probes return dead() directly without exception.
    // The whole result is walked, not just `detail` — see `redactDeep` and `LiveProbeResult`'s doc
    // comment.
    return redactDeep(result, secrets);
  } catch (err) {
    if (isBudgetError(err)) {
      // Said plainly, because the remedy is not the credential's: a probe that timed out is not a
      // probe that answered "dead", and an operator who reads `The operation was aborted` has to
      // work out which of the two they are looking at. Still graded `dead` — unverified is not
      // verified, and `checkLiveness` exists to stop a deploy reading as healthy on a maybe.
      return dead(key, `timed out — the ${budget.totalMs}ms budget for the whole probe run elapsed before this answered`);
    }
    return dead(key, redact(err instanceof Error ? err.message : String(err), secrets));
  }
}

export async function runLiveProbes(
  input: LiveProbeInput,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LiveProbeResult[]> {
  /**
   * ONE deadline for the whole call, not one per request — see `DEFAULT_TIMEOUT_MS`. Every `fetch`
   * below gets a signal for whatever is left of it, and `attempt()` bounds each probe by the same
   * remainder, so `runLiveProbes` returns within `timeoutMs` regardless of what any injected
   * function does.
   */
  // `performance.now()`, not `Date.now()`: the deadline measures ELAPSED time, and the wall clock is
  // not a measure of elapsed time. It steps — NTP correction, a laptop waking, a VM's host resyncing
  // it — and a step is indistinguishable from time passing when you subtract two readings. Caught
  // here rather than reasoned about: this machine jumped ~40s forward and back mid-run while these
  // probes were being tested, which made one run report a 40383 ms elapsed and the next -39781 ms.
  // Forward, that aborts every probe the instant it starts and reports seven live credentials dead;
  // backward, it silently extends the budget the route's whole contract rests on. `setTimeout` in
  // `withDeadline` is already monotonic (libuv), so this makes the two agree.
  const deadline = performance.now() + timeoutMs;
  // `Math.ceil`: `AbortSignal.timeout` refuses a non-integer delay outright (`ERR_OUT_OF_RANGE`),
  // and `performance.now()` is fractional.
  const remainingMs = (): number => Math.max(Math.ceil(deadline - performance.now()), 0);
  const signal = (): AbortSignal => AbortSignal.timeout(remainingMs());
  const budget = { remainingMs, totalMs: timeoutMs };

  // Result order (== the array order returned below), fixed and callers may rely on it:
  //   google_auth, google_drive_review, google_drive_approved, google_sheets, lark, typefully, telegram
  // Drive was a single "google_drive" key through 2026-08-10, covering both folders in one result.
  // It split into a key per folder so a broken review folder and a broken approved folder are
  // distinguishable by name — the way `doctor --live` told them apart before this module replaced
  // its inline checks.

  // One mutable array for the whole call, not a fresh one per `attempt()`: the Google token and
  // Lark's tenant token are not known until a probe is already in flight, so neither can be in a
  // `secrets` literal built up front. `attempt()` only reads `secrets` AFTER `run()` resolves, so
  // pushing a token onto this same array the moment it is obtained — before that probe's own
  // redaction step — makes it available there too, not just to the probes that come after. Getting
  // this wrong is exactly how `google_auth`'s `grantedScopes` carried the live token through
  // tokeninfo's response unredacted: its `attempt()` call used to be given a hardcoded `[]`.
  const secrets: (string | undefined)[] = [input.lark?.appSecret, input.typefully?.apiKey, input.telegramBotToken];

  const probe = (key: ProbeKey, run: () => Promise<LiveProbeResult>) => attempt(key, secrets, budget, run);

  /**
   * The Google token, started once and shared by the four probes that need it, rather than obtained
   * inside a `google_auth` probe the other three then wait on. Both halves matter:
   *
   * - *Shared*, so Drive and Sheets do not each refresh their own.
   * - *Started here, in parallel with everything else*, so a hanging Google does not eat the run's
   *   single deadline before Lark, Typefully and Telegram have made their calls. The old shape ran
   *   `google_auth` sequentially first; under one shared budget that is starvation, and it would
   *   report four healthy credentials as timed out on the strength of a fifth being slow.
   *
   * The `.then` that pushes onto `secrets` is registered before any probe awaits this promise, so it
   * runs first and every consumer's redaction already knows the token.
   */
  let tokenPromise: Promise<string> | undefined;
  if (input.googleToken) {
    tokenPromise = input.googleToken(signal());
    tokenPromise.then(
      (t) => secrets.push(t),
      () => {
        /* handled by each consumer's own try/catch; attached here only so a rejection is never
           unhandled when config leaves every consumer but `google_auth` skipped */
      },
    );
  }

  const googleAuth = async (): Promise<LiveProbeResult> => {
    if (!tokenPromise) return skipped("google_auth", "no Google OAuth credentials");
    const token = await tokenPromise;
    // Best-effort: which scopes actually ended up on the token matters to callers (a token
    // missing `spreadsheets` scope is a different fix than a wrong GSHEET_ID — see
    // `sheetAccessResult`), but `tokeninfo` failing must not fail this probe: the token itself
    // still refreshed, which is what "ok" means here. The failure is discarded, not returned or
    // rethrown, so it can never carry the token — which is literally in this call's URL — into a
    // detail string or an exception `attempt()` would otherwise redact-and-report.
    let grantedScopes: string[] | undefined;
    try {
      const info = (await fetchFn(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {
        signal: signal(),
      }).then((r) => r.json())) as { scope?: string };
      grantedScopes = parseScopes(info.scope);
    } catch {
      /* tokeninfo unreachable — the token still refreshed; scopes just aren't known this run */
    }
    return alive("google_auth", "token refreshed", { grantedScopes });
  };

  /** The token for a probe downstream of it, or `undefined` if it never came. Never rethrows: the
   *  auth probe above is where a refresh failure is reported, and blaming a folder id for it is the
   *  mis-blame `tests/doctor/checks.test.ts` already guards against for the Sheet's 404. */
  const tokenOrUndefined = async (): Promise<string | undefined> => {
    if (!tokenPromise) return undefined;
    try {
      return await tokenPromise;
    } catch {
      return undefined;
    }
  };

  const DRIVE_NOT_CONFIGURED = "GDRIVE_REVIEW_FOLDER_ID / GDRIVE_APPROVED_FOLDER_ID unset";
  /** One folder's reachability, parameterised by key/label/id — `input.googleDrive` is only ever
   *  present with both ids set (`loadGoogleDriveConfig` requires both together), so the two probes
   *  built from it only differ in which folder they name. */
  const driveFolder = (key: ProbeKey, label: string, id: string) => async (): Promise<LiveProbeResult> => {
    const token = await tokenOrUndefined();
    if (!token) return dead(key, "not checked — the Google token could not be refreshed");
    // `,name` alongside `id`: the same extra field the pre-module implementation asked for, so the
    // rendered check can name the folder it reached, not just report that reaching it worked.
    const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal(),
    });
    if (!res.ok) return dead(key, `${label} folder unreachable — HTTP ${res.status}`, { httpStatus: res.status });
    const body = (await res.json()) as { name?: string };
    return alive(key, `${label} folder reachable`, { resourceName: body.name });
  };
  const googleDriveReview = input.googleDrive
    ? driveFolder("google_drive_review", "review", input.googleDrive.reviewFolderId)
    : async () => skipped("google_drive_review", DRIVE_NOT_CONFIGURED);
  const googleDriveApproved = input.googleDrive
    ? driveFolder("google_drive_approved", "approved", input.googleDrive.approvedFolderId)
    : async () => skipped("google_drive_approved", DRIVE_NOT_CONFIGURED);

  const googleSheets = async (): Promise<LiveProbeResult> => {
    if (!input.googleSheetId) return skipped("google_sheets", "GSHEET_ID unset");
    const token = await tokenOrUndefined();
    if (!token) return dead("google_sheets", "not checked — the Google token could not be refreshed");
    // `,properties.title` alongside `spreadsheetId`: same reasoning as the Drive folder's `,name` above.
    const res = await fetchFn(
      `https://sheets.googleapis.com/v4/spreadsheets/${input.googleSheetId}?fields=spreadsheetId,properties.title`,
      { headers: { Authorization: `Bearer ${token}` }, signal: signal() },
    );
    if (!res.ok) return dead("google_sheets", `HTTP ${res.status}`, { httpStatus: res.status });
    const body = (await res.json()) as { properties?: { title?: string } };
    return alive("google_sheets", "spreadsheet reachable", { resourceName: body.properties?.title });
  };

  const lark = async (): Promise<LiveProbeResult> => {
    if (!input.lark) return skipped("lark", "LARK_APP_ID / LARK_APP_SECRET unset");
    const res = await fetchFn(`${input.lark.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: input.lark.appId, app_secret: input.lark.appSecret }),
      signal: signal(),
    });
    if (!res.ok) return dead("lark", `HTTP ${res.status}`, { httpStatus: res.status });
    // Lark answers 200 with a non-zero `code` for a bad secret — the status line alone would pass.
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (body.code !== 0 || !body.tenant_access_token) {
      return dead("lark", `Lark code ${body.code} — ${body.msg ?? "no message"}`);
    }
    // A tenant token issues fine for an app that has been removed from every room — proving the
    // token is real is not proving `pnpm collect-lark` (im:message.group_msg) has anything to read.
    // Listing chats needs nothing beyond the app credentials already used above (see `pnpm
    // lark:chats`, meant to run before any chat id is known — LARK_CHAT_IDS is deliberately unset on
    // the deployment), so this evidence is available in both places this module runs. A chat-list
    // failure must not fail this probe: the token itself is still real, so it degrades to the
    // token-only detail rather than propagating. Reports a count, never chat names — a name is
    // response content this module has no reason to trust is safe to print.
    try {
      const chats = await fetchFn(`${input.lark.baseUrl}/open-apis/im/v1/chats?page_size=100`, {
        headers: { Authorization: `Bearer ${body.tenant_access_token}` },
        signal: signal(),
      });
      const chatsBody = (await chats.json()) as { code?: number; data?: { items?: unknown[] } };
      if (chats.ok && chatsBody.code === 0) {
        const n = chatsBody.data?.items?.length ?? 0;
        return alive("lark", `tenant token OK · bot in ${n} chat(s) (im:message.group_msg verified by pnpm collect-lark)`);
      }
    } catch {
      /* chat list unreachable — the tenant token itself is still real */
    }
    return alive("lark", "tenant token issued — could not verify chat membership");
  };

  /**
   * Two calls, on purpose, and this is a restoration rather than an addition. The pre-module
   * `doctor --live` called `/v2/me` and then the social set specifically so that four failures with
   * four different remedies stayed four different messages:
   *
   *   | `/v2/me` 401/403      | the key itself was rejected — check TYPEFULLY_API_KEY            |
   *   | `/v2/me` other non-2xx| Typefully's side is failing — do not go re-check a good key      |
   *   | `/v2/me` ok, set not  | the key is fine and the id is not — check TYPEFULLY_SOCIAL_SET_ID|
   *   | `fetch` rejects       | unreachable — DNS/TLS/connection, not a credential at all        |
   *
   * A single social-set call collapses all four into one HTTP code: a 401 there could be either of
   * the first two variables and a 404 could be either of the last two causes. Sending an operator to
   * rotate a perfectly good API key during a Typefully outage is the concrete cost, and it is the
   * kind of thing that only shows up on the unhappy path nobody measured.
   *
   * Sequential, not parallel: when the key is dead there is nothing to learn from the social set,
   * and the run's single deadline already bounds the pair (see `DEFAULT_TIMEOUT_MS`).
   */
  const typefully = async (): Promise<LiveProbeResult> => {
    if (!input.typefully) return skipped("typefully", "TYPEFULLY_API_KEY / TYPEFULLY_SOCIAL_SET_ID unset");
    const headers = { Authorization: `Bearer ${input.typefully.apiKey}` };

    let me: Response;
    try {
      me = await fetchFn("https://api.typefully.com/v2/me", { headers, signal: signal() });
    } catch (err) {
      // A spent budget is not "unreachable" — `attempt()` phrases that one, and it names the budget.
      if (isBudgetError(err)) throw err;
      return dead("typefully", `unreachable — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!me.ok) {
      const detail =
        me.status === 401 || me.status === 403
          ? `GET /v2/me → HTTP ${me.status} — check TYPEFULLY_API_KEY`
          : `GET /v2/me → HTTP ${me.status} — Typefully upstream failure, not necessarily your key`;
      return dead("typefully", detail, { httpStatus: me.status });
    }

    // The trailing slash is required — without it the API answers 301 with an empty body. Confirmed
    // live 2026-07-29; `TypefullyQuota.ts` carries the same note over the same URL.
    let res: Response;
    try {
      res = await fetchFn(`https://api.typefully.com/v2/social-sets/${input.typefully.socialSetId}/`, {
        headers,
        signal: signal(),
      });
    } catch (err) {
      if (isBudgetError(err)) throw err;
      return dead("typefully", `key OK, social set unreachable — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      return dead("typefully", `key OK, social set unreadable — HTTP ${res.status} — check TYPEFULLY_SOCIAL_SET_ID`, {
        httpStatus: res.status,
      });
    }

    // Same field names TypefullyQuota.ts reads off this response. `used` is required, not defaulted,
    // there too — an absent `used` is a different (and untrustworthy) answer from a real zero, per
    // that file's own comment — so a response missing either number is reported reachable with no
    // quota, rather than guessing one. Deliberately `ok` and not `dead`, which is where this differs
    // from `TypefullyQuota.read()` throwing on the same payload: that read exists to decide whether
    // a send may proceed, and this one only asks whether the credential is alive. It demonstrably is
    // — two calls just answered with it.
    const body = (await res.json()) as { publishing_quota?: { used?: number; remaining?: number; resets_at?: string } };
    const q = body.publishing_quota;
    if (!q || typeof q.remaining !== "number" || typeof q.used !== "number") {
      return alive("typefully", "key OK · social set reachable — the response carried no readable publishing quota");
    }
    return alive("typefully", "key OK · social set reachable", {
      quota: { remaining: q.remaining, limit: q.used + q.remaining, resetsAt: q.resets_at },
    });
  };

  const telegram = async (): Promise<LiveProbeResult> => {
    if (!input.telegramBotToken) return skipped("telegram", "TELEGRAM_BOT_TOKEN unset");
    // getMe validates the token and sends nothing. The token is in the path — see `redact`.
    const res = await fetchFn(`https://api.telegram.org/bot${input.telegramBotToken}/getMe`, { signal: signal() });
    return res.ok
      ? alive("telegram", "bot token valid")
      : dead("telegram", `HTTP ${res.status}`, { httpStatus: res.status });
  };

  // All seven at once, under the one deadline. `Promise.all` preserves array position, so the fixed
  // result order documented above survives the probes finishing in whatever order they finish in.
  return Promise.all([
    probe("google_auth", googleAuth),
    probe("google_drive_review", googleDriveReview),
    probe("google_drive_approved", googleDriveApproved),
    probe("google_sheets", googleSheets),
    probe("lark", lark),
    probe("typefully", typefully),
    probe("telegram", telegram),
  ]);
}

