import type { CheckResult } from "../doctor/report";

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
  integrations?: { label: string; configured: boolean }[];
}

/**
 * Judges the four calls `deploy:smoke` makes before logging in — see the spec's "Before logging
 * in" section. Each is its own `CheckResult` so a single wrong status code names itself instead of
 * being folded into one generic "anonymous checks failed" line.
 */
export function checkAnonymous(codes: {
  root: number;
  status: number;
  foreignOrigin: number;
  unknownPath: number;
}): CheckResult[] {
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
    {
      name: "GET /unknown-path",
      status: codes.unknownPath === 200 ? "ok" : "fail",
      detail:
        codes.unknownPath === 200
          ? "SPA served"
          : `Expected 200, got ${codes.unknownPath} — an unknown path should fall through to the SPA, not error.`,
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
  return { name: "POST /api/login", status: "fail", detail: `Expected 200, got ${code}.` };
}

/**
 * Judges the post-login `/api/status` payload against the spec's "After logging in" list. Total
 * over its input: a missing or wrong-typed field is a `fail` with a readable detail, never a
 * thrown exception, since the entry point hands this parsed JSON it never validated.
 *
 * `availableTargets` missing `google` is `fail` — Google Drive is the record of truth in cloud
 * mode, so its absence means §3 credentials are missing and the deployment publishes nowhere.
 * Missing `lark` is only `warn` — Lark is an opt-in publish target, not a load-bearing one.
 */
export function checkStatus(payload: StatusPayload): CheckResult[] {
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
    for (const integration of integrations) {
      const label = typeof integration?.label === "string" ? integration.label : "(unnamed)";
      results.push(
        integration?.configured === true
          ? { name: `integration: ${label}`, status: "ok", detail: "configured" }
          : { name: `integration: ${label}`, status: "fail", detail: `${label} is not configured.` },
      );
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

/** Judges `/api/status` after logout — the session must be gone, so a fresh 401 is expected. */
export function checkLogout(statusCodeAfterLogout: number): CheckResult {
  if (statusCodeAfterLogout === 401) {
    return { name: "logout", status: "ok", detail: "401 after logout, session cleared" };
  }
  return {
    name: "logout",
    status: "fail",
    detail: `Expected 401 after logout, got ${statusCodeAfterLogout} — the session was not cleared.`,
  };
}
