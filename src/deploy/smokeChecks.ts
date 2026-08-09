import type { CheckResult } from "../doctor/report";
import { SESSION_COOKIE_NAME } from "../adapters/web/sessionCookie";
import type { LiveProbeResult, ProbeKey } from "../doctor/liveProbes";

/**
 * The parsed shape of a running deployment's `/api/status` response (`StatusView`,
 * `src/adapters/web/apiHandlers.ts:35`), as seen by `deploy:smoke` after `JSON.parse`-ing an
 * unvalidated HTTP body. Every field is optional on purpose: a malformed or truncated response is
 * a normal input to `checkStatus`, not a programmer error, so the field being `undefined` must
 * produce a `fail` result rather than a thrown `TypeError`.
 */
export interface StatusPayload {
  storageMode?: string;
  dbEnv?: string;
  sendsEnabled?: boolean;
  conversionEnabled?: boolean;
  availableTargets?: string[];
  /** `key` is `IntegrationStatus.key` (`apiHandlers.ts`) — the stable identifier `checkStatus` grades
   *  severity on. `label` is display text only, and must never be switched on: it is Korean for some
   *  entries, English for others, and free to change without meaning anything changed underneath. */
  integrations?: { key?: string; label: string; configured: boolean }[];
}

/**
 * Judges the three calls `deploy:smoke` makes before logging in — see the spec's "Before logging
 * in" section. Each is its own `CheckResult` so a single wrong status code names itself instead of
 * being folded into one generic "anonymous checks failed" line.
 *
 * There is no unknown-path expectation here on purpose. This dashboard is hash-routed
 * (`web/src/Root.tsx`, `web/src/App.tsx`), so no deep link ever needs a server-side SPA fallback,
 * and `vercel.json` has no `rewrites` entry — Vercel's static layer answers an unknown path with a
 * plain 404. A prior version of this check expected 200 there, verified only against
 * `src/cli/staticFiles.ts`'s rehearsal-server fallback (see its own comment), which is the exact
 * layer this command is supposed to be checking, not standing in for. Do not add a rewrite to make
 * that expectation true — it would exist only to satisfy this script, not because anything needs it.
 *
 * `codes` itself is guarded before any property read, same reasoning as `checkStatus`'s top-level
 * guard: a caller that builds this object from something that failed upstream (a rejected
 * `Promise.all`, a bad destructure) can hand this function `null`/`undefined` as easily as
 * `JSON.parse` can hand `checkStatus` one, and this module never throws regardless of which
 * function is asked to judge malformed input.
 */
export function checkAnonymous(codes: {
  root: number;
  status: number;
  foreignOrigin: number;
}): CheckResult[] {
  if (codes === null || typeof codes !== "object") {
    const detail = `Expected an object of status codes, got ${JSON.stringify(codes)}.`;
    return [
      { name: "GET /", status: "fail", detail },
      { name: "GET /api/status (anonymous)", status: "fail", detail },
      { name: "POST /api/login (foreign origin)", status: "fail", detail },
    ];
  }

  return [
    {
      name: "GET /",
      status: codes.root === 200 ? "ok" : "fail",
      detail: codes.root === 200 ? "SPA served" : `Expected 200, got ${codes.root} — the SPA did not load.`,
    },
    {
      name: "GET /api/status (anonymous)",
      status: codes.status === 401 ? "ok" : "fail",
      detail:
        codes.status === 401
          ? "401 as expected"
          : `Expected 401, got ${codes.status} — an unauthenticated caller can read deployment status.`,
    },
    {
      name: "POST /api/login (foreign origin)",
      status: codes.foreignOrigin === 403 ? "ok" : "fail",
      detail:
        codes.foreignOrigin === 403
          ? "403 as expected"
          : `Expected 403, got ${codes.foreignOrigin} — the CSRF guard is not refusing a foreign Origin.`,
    },
  ];
}

/**
 * Judges `POST /api/login`'s status code. A 403 is singled out because it is the one place
 * `HERALD_DEPLOYMENT_ORIGIN` being wrong becomes visible — `deploy:check` cannot read the value
 * back, so this is the only check that can name it. Any other non-200 is a plain failure that does
 * not mention the origin, so the 403 case stays the one meaningful signal.
 */
export function checkLogin(code: number): CheckResult {
  if (code === 200) {
    return { name: "POST /api/login", status: "ok", detail: "200 as expected" };
  }
  if (code === 403) {
    return {
      name: "POST /api/login",
      status: "fail",
      detail: "403 — HERALD_DEPLOYMENT_ORIGIN likely does not match this deployment's real origin.",
    };
  }
  /**
   * By far the most likely failure, and the one a bare `Expected 200, got 401.` served worst. The
   * deployment answers 401 identically for an empty password, a one-character one and a wrong
   * full-length one (an empty string is still a string, so `handleApi` reaches the login rather than
   * refusing with 400). An operator trying those three in a row therefore sees the same line three
   * times and reasonably concludes the prompt is not reading their input — which is what happened on
   * 2026-08-05. Say what 401 means, and say that the attempts are rationed, because the next thing
   * they will do is try again.
   */
  if (code === 401) {
    return {
      name: "POST /api/login",
      status: "fail",
      detail:
        "401 — wrong username or password. Every wrong value answers 401 the same way, so retrying " +
        "variations tells you nothing. 5 failed attempts from one address lock it for 60 seconds.",
    };
  }
  if (code === 429) {
    return {
      name: "POST /api/login",
      status: "fail",
      detail:
        "429 — this address is locked out: 5 failed logins within 60 seconds. Wait a minute before " +
        "retrying. Nothing is wrong with the deployment.",
    };
  }
  return { name: "POST /api/login", status: "fail", detail: `Expected 200, got ${code}.` };
}

/**
 * Judged before the request, not after: an empty username or password cannot succeed, and sending
 * one anyway spends one of the five attempts the deployment allows per address per minute. Losing a
 * fifth of that budget to a keystroke that never registered is exactly how an operator ends up
 * locked out of production while trying to verify it.
 */
export function checkCredentials(username: string, password: string): CheckResult {
  const missing = [!username.trim() && "username", !password && "password"].filter(Boolean).join(" and ");
  if (!missing) {
    return { name: "Credentials entered", status: "ok", detail: "username and password both given" };
  }
  return {
    name: "Credentials entered",
    status: "fail",
    detail:
      `No ${missing} was typed — an empty one cannot succeed, so it was not sent. ` +
      "Each attempt spends one of the 5 this address gets per minute.",
  };
}

/**
 * Judges the post-login `/api/status` payload against the spec's "After logging in" list. Total
 * over its input: a missing or wrong-typed field is a `fail` with a readable detail, never a
 * thrown exception, since the entry point hands this parsed JSON it never validated.
 *
 * `availableTargets` missing `google` is `fail` — Google Drive is the record of truth in cloud
 * mode, so its absence means §3 credentials are missing and the deployment publishes nowhere.
 * Missing `lark` is only `warn` — Lark is an opt-in publish target, not a load-bearing one.
 *
 * The top-level `payload` itself is guarded the same way every field already was: `JSON.parse` of
 * a response body can legitimately produce `null` (a literal `null` body) or `undefined` isn't far
 * off either once an `as StatusPayload` cast is involved, and property access on either throws
 * before any field-level guard runs. When that happens, every expectation this function would
 * otherwise check comes back `fail` — never `warn`, since "malformed payload" cannot be
 * distinguished from "lark absent" and defaulting to the milder verdict would hide the real
 * problem — so the operator sees which checks could not be evaluated instead of a stack trace.
 */
export function checkStatus(payload: StatusPayload): CheckResult[] {
  if (payload === null || typeof payload !== "object") {
    const detail = `Expected a status object, got ${JSON.stringify(payload)} — the response body did not parse into the expected shape.`;
    return [
      { name: "storageMode", status: "fail", detail },
      { name: "dbEnv", status: "fail", detail },
      { name: "sendsEnabled", status: "fail", detail },
      { name: "conversionEnabled", status: "fail", detail },
      { name: "availableTargets: google", status: "fail", detail },
      { name: "availableTargets: lark", status: "fail", detail },
      { name: "integrations", status: "fail", detail },
    ];
  }

  const results: CheckResult[] = [];

  results.push(
    payload.storageMode === "cloud"
      ? { name: "storageMode", status: "ok", detail: "cloud" }
      : {
          name: "storageMode",
          status: "fail",
          detail: `Expected "cloud", got ${JSON.stringify(payload.storageMode)} — local mode writes to an ephemeral filesystem.`,
        },
  );

  results.push(
    payload.dbEnv === "production"
      ? { name: "dbEnv", status: "ok", detail: "production" }
      : {
          name: "dbEnv",
          status: "fail",
          detail: `Expected "production", got ${JSON.stringify(payload.dbEnv)} — this deployment points at a non-production database.`,
        },
  );

  results.push(
    payload.sendsEnabled === false
      ? { name: "sendsEnabled", status: "ok", detail: "false" }
      : {
          name: "sendsEnabled",
          status: "fail",
          detail: `Expected false, got ${JSON.stringify(payload.sendsEnabled)} — sends should ship closed on first deploy.`,
        },
  );

  results.push(
    payload.conversionEnabled === false
      ? { name: "conversionEnabled", status: "ok", detail: "false" }
      : {
          name: "conversionEnabled",
          status: "fail",
          detail: `Expected false, got ${JSON.stringify(payload.conversionEnabled)} — the hosted route set has no local conversion agent.`,
        },
  );

  const targets = Array.isArray(payload.availableTargets) ? payload.availableTargets : [];
  results.push(
    targets.includes("google")
      ? { name: "availableTargets: google", status: "ok", detail: "present" }
      : {
          name: "availableTargets: google",
          status: "fail",
          detail: "google is missing — Google Drive credentials are not configured, nothing publishes to the record of truth.",
        },
  );
  results.push(
    targets.includes("lark")
      ? { name: "availableTargets: lark", status: "ok", detail: "present" }
      : {
          name: "availableTargets: lark",
          status: "warn",
          detail: "lark is missing — Lark is an opt-in publish target, this may be expected.",
        },
  );

  const integrations = Array.isArray(payload.integrations) ? payload.integrations : [];
  if (integrations.length === 0) {
    results.push({
      name: "integrations",
      status: "fail",
      detail: "No integrations reported — expected the status payload to list at least one.",
    });
  } else {
    // Severity keys off `key` (a stable identifier), never `label` (Korean display text that is
    // free to change without meaning anything underneath changed). `google_drive` is the only `fail`:
    // it is the record of truth in cloud mode, and its absence is the silent-degradation case these
    // commands exist to catch. Everything else — the `collect` group (this hosted deployment never
    // collects, so `docs/ko/setup/vercel.md` tells the operator not to register those keys at all),
    // Lark Drive, Telegram, Typefully, Google Sheets, the local folder — degrades in silence exactly
    // like `requirements.ts` already grades their env vars (`warn`, not `fail`); grading them `fail`
    // here would make a correct, intentionally-minimal deployment exit 1.
    for (const integration of integrations) {
      const label = typeof integration?.label === "string" ? integration.label : "(unnamed)";
      const key = typeof integration?.key === "string" ? integration.key : undefined;
      if (integration?.configured === true) {
        results.push({ name: `integration: ${label}`, status: "ok", detail: "configured" });
      } else if (key === "google_drive") {
        results.push({
          name: `integration: ${label}`,
          status: "fail",
          detail: `${label} is not configured — it is the record of truth in cloud mode.`,
        });
      } else {
        results.push({ name: `integration: ${label}`, status: "warn", detail: `${label} is not configured.` });
      }
    }
  }

  return results;
}

/**
 * Judges `POST /api/items/:id/convert-prepare` on the hosted route set, where the route must not
 * exist at all — a 404, not merely a rejection. A 403 or 200 both mean the route is present, which
 * is the failure the spec calls out explicitly ("so the route is genuinely absent rather than
 * merely rejecting").
 */
export function checkConvertPrepare(code: number): CheckResult {
  if (code === 404) {
    return { name: "POST /api/items/:id/convert-prepare", status: "ok", detail: "404 as expected — route is absent" };
  }
  return {
    name: "POST /api/items/:id/convert-prepare",
    status: "fail",
    detail: `Expected 404, got ${code} — the hosted route set should not expose this route at all.`,
  };
}

/**
 * Judges `POST /api/logout`'s own response, not a second, unauthenticated `/api/status` probe made
 * afterwards. That probe used to be this check's only signal — but sent with no cookie, it is
 * byte-identical to the anonymous `/api/status` call `checkAnonymous` already asserts 401 on earlier
 * in the same run, so it proves nothing about `/api/logout` itself: a deployment whose logout route
 * 404s would still print a passing check.
 *
 * Per `apiHandlers.ts`'s own comment, the token is deliberately not revoked server-side — a copy of
 * the old cookie saved before logout and replayed directly could legitimately still work — so
 * asserting a fresh `/api/status` call now returns 401 would fail a correct deployment as easily as
 * it would pass a broken one. The two assertions this function CAN make honestly are about the
 * logout response itself: it returned 200, and its `Set-Cookie` actually clears the session cookie
 * in the browser.
 */
export function checkLogout(statusCode: number, setCookieHeader: string | undefined): CheckResult[] {
  const cleared = clearsSessionCookie(setCookieHeader);
  return [
    {
      name: "POST /api/logout",
      status: statusCode === 200 ? "ok" : "fail",
      detail: statusCode === 200 ? "200 as expected" : `Expected 200, got ${statusCode}.`,
    },
    {
      name: "POST /api/logout (Set-Cookie)",
      status: cleared ? "ok" : "fail",
      detail: cleared
        ? `Set-Cookie clears ${SESSION_COOKIE_NAME}`
        : `Expected a Set-Cookie clearing ${SESSION_COOKIE_NAME}, got ${JSON.stringify(setCookieHeader)} — the browser was not told to drop its session cookie.`,
    },
  ];
}

/** A `Set-Cookie` header clears the session when it names `SESSION_COOKIE_NAME` with an empty value
 *  and `Max-Age=0` — the exact shape `CLEARED_SESSION_COOKIE` (`sessionCookie.ts`) builds. Matched by
 *  parsing rather than string equality so this survives a header the runtime reorders or reformats. */
function clearsSessionCookie(setCookieHeader: string | undefined): boolean {
  if (!setCookieHeader) return false;
  const [nameValue] = setCookieHeader.split(";");
  const eq = nameValue.indexOf("=");
  if (eq === -1) return false;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  return name === SESSION_COOKIE_NAME && value === "" && /max-age=0/i.test(setCookieHeader);
}

/**
 * Severity by what the credential is for, not by which API answered. Publishing is what this
 * deployment exists to do, so a dead publish credential fails; sends ship closed and follow the flag
 * the same status payload already carries; the Sheet is header links.
 *
 * `skipped` is ok, never a failure — presence is `deploy:check`'s job, and a Telegram-only install
 * must not go red because Lark Drive is absent. Same split `requirements.ts` draws, same reason.
 *
 * Drive is two keys, not one (`google_drive_review` and `google_drive_approved` — `liveProbes.ts`
 * split it so a broken review folder and a broken approved folder are distinguishable by name), and
 * both are publishing credentials, so both are classified `"publish"` below.
 */
type ProbeTier = "publish" | "send" | "data";

/**
 * `Record<ProbeKey, ProbeTier>`, not two arrays checked with `.includes()`. The array shape is what
 * this map replaced: a probe added to `runLiveProbes` (`liveProbes.ts`) but never added to either
 * list produced no compile error — `.includes()` on a plain string list accepts, and silently
 * rejects, any string equally — and fell through to `warn` regardless of `sendsEnabled`, which is a
 * milder replay of the exact false-green incident this plan responds to. `LiveProbeResult.key` is
 * typed `ProbeKey`, so a `Record` indexed by that same union makes the classification exhaustive:
 * adding a key to `ProbeKey` without adding it here fails `pnpm typecheck` at this object literal,
 * not at some caller three files away.
 */
const PROBE_TIER: Record<ProbeKey, ProbeTier> = {
  google_auth: "publish",
  google_drive_review: "publish",
  google_drive_approved: "publish",
  lark: "publish",
  typefully: "send",
  telegram: "send",
  google_sheets: "data",
};

/**
 * `dead`/`ok`/`skipped` was already judged by the caller; this only classifies a `dead` probe's
 * severity by tier. The `default` branch is the runtime half of the same "unknown is not-known"
 * argument the `undefined`-route case above already makes: `PROBE_TIER` is exhaustive over `ProbeKey`
 * at compile time, but a key can still reach here having escaped the type system — a hand-built
 * `LiveProbeResult` in a test, or a live deployment answering with a probe key this build of
 * `deploy:smoke` predates. Defaulting to `fail` rather than `warn` matches the rest of this module:
 * this command's whole purpose is to stop a deploy reading as healthy when something is unverified,
 * so not-knowing which tier a credential belongs to is graded the same as knowing it is dead.
 */
function liveSeverity(key: ProbeKey, sendsEnabled: boolean): CheckResult["status"] {
  const tier = PROBE_TIER[key];
  switch (tier) {
    case "publish":
      return "fail";
    case "send":
      return sendsEnabled ? "fail" : "warn";
    case "data":
      return "warn";
    default:
      return "fail";
  }
}

/**
 * Judges `GET /api/diagnostics/live`'s probe results — the one thing `checkStatus` cannot tell you:
 * whether the credentials behind those `present` flags still work. `probes` is `undefined` when the
 * route itself could not be read (an old deployment without it, or one answering an error), which is
 * a `fail`, not a pass — the same false clean bill this whole plan exists to remove.
 */
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
    return { name, status: liveSeverity(probe.key, sendsEnabled), detail: probe.detail };
  });
}
