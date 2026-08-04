import { describe, it, expect } from "vitest";
import {
  checkAnonymous, checkLogin, checkStatus, checkConvertPrepare, checkLogout,
  type StatusPayload,
} from "../../src/deploy/smokeChecks";
import { SESSION_COOKIE_NAME } from "../../src/adapters/web/sessionCookie";

const HEALTHY: StatusPayload = {
  storageMode: "cloud",
  dbEnv: "production",
  sendsEnabled: false,
  conversionEnabled: false,
  availableTargets: ["local", "google", "lark"],
  integrations: [
    { key: "google_drive", label: "Google Drive", configured: true },
    { key: "telegram", label: "Telegram", configured: true },
  ],
};

const failures = (rs: CheckResultLike[]) => rs.filter((r) => r.status === "fail");
type CheckResultLike = { name: string; status: string; detail: string };

describe("checkAnonymous", () => {
  it("passes the shape a correct deployment answers with", () => {
    expect(failures(checkAnonymous({ root: 200, status: 401, foreignOrigin: 403 }))).toEqual([]);
  });

  it("fails when the API answers an unauthenticated caller", () => {
    // 200 here means every route is open to the internet.
    expect(failures(checkAnonymous({ root: 200, status: 200, foreignOrigin: 403 }))).not.toEqual([]);
  });

  it("fails when a foreign origin is not refused", () => {
    expect(failures(checkAnonymous({ root: 200, status: 401, foreignOrigin: 200 }))).not.toEqual([]);
  });

  // No unknown-path expectation: the dashboard is hash-routed (no deep link ever needs a
  // server-side SPA fallback), `vercel.json` has no `rewrites`, and real Vercel 404s an unknown path
  // — a prior version of this check expected 200 there and failed every correct deployment.
  it("does not check an unknown path at all", () => {
    const rs = checkAnonymous({ root: 200, status: 401, foreignOrigin: 403 });
    expect(rs.some((r) => /unknown/i.test(r.name))).toBe(false);
  });

  // Same class of bug checkStatus had: a caller-assembled object can be null/undefined before any
  // property on it is ever read.
  it("does not throw and fails everything when codes is null", () => {
    expect(() => checkAnonymous(null as unknown as Parameters<typeof checkAnonymous>[0])).not.toThrow();
    expect(failures(checkAnonymous(null as unknown as Parameters<typeof checkAnonymous>[0]))).not.toEqual([]);
  });

  it("does not throw and fails everything when codes is undefined", () => {
    expect(() => checkAnonymous(undefined as unknown as Parameters<typeof checkAnonymous>[0])).not.toThrow();
    expect(failures(checkAnonymous(undefined as unknown as Parameters<typeof checkAnonymous>[0]))).not.toEqual([]);
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
      integrations: [
        { key: "google_drive", label: "Google Drive", configured: false },
        { key: "telegram", label: "Telegram", configured: true },
      ],
    });
    expect(rs.some((r) => r.detail.includes("Google Drive"))).toBe(true);
  });

  // The finding this branch shipped with: grading every unconfigured integration `fail` makes a
  // correct deployment exit 1, because the hosted deployment never collects and the runbook tells
  // the operator not to register `TWITTERAPI_IO_KEY` at all. Severity is keyed on `key`, not `label`.
  it("warns, not fails, when an unconfigured integration is not Google Drive", () => {
    const rs = checkStatus({
      ...HEALTHY,
      integrations: [{ key: "twitterapi", label: "X (twitterapi.io)", configured: false }],
    });
    expect(failures(rs)).toEqual([]);
    expect(rs.find((r) => r.name.includes("twitterapi.io"))?.status).toBe("warn");
  });

  // Google Drive is the record of truth in cloud mode — its absence is the one silent-degradation
  // case these commands exist to catch, so it alone stays `fail`.
  it("fails when the Google Drive integration is unconfigured", () => {
    const rs = checkStatus({
      ...HEALTHY,
      integrations: [{ key: "google_drive", label: "Google Drive", configured: false }],
    });
    expect(rs.find((r) => r.name.includes("Google Drive"))?.status).toBe("fail");
  });

  // A JSON.parse'd response body can be a literal `null`, and an `as StatusPayload` cast lets
  // `undefined` through the type system too. Neither should throw before the field-level guards
  // ever run.
  it("does not throw and fails everything when the payload is null", () => {
    expect(() => checkStatus(null as unknown as StatusPayload)).not.toThrow();
    expect(failures(checkStatus(null as unknown as StatusPayload))).not.toEqual([]);
  });

  it("does not throw and fails everything when the payload is undefined", () => {
    expect(() => checkStatus(undefined as unknown as StatusPayload)).not.toThrow();
    expect(failures(checkStatus(undefined as unknown as StatusPayload))).not.toEqual([]);
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
  const CLEARED = `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;

  it("passes a 200 with a Set-Cookie that clears the session", () => {
    expect(failures(checkLogout(200, CLEARED))).toEqual([]);
  });

  it("fails the status check when logout does not return 200", () => {
    // The bug this replaces: the old check replayed the anonymous /api/status call and could pass
    // even when /api/logout itself 404s. The status of the logout response itself must be judged.
    const rs = checkLogout(404, CLEARED);
    expect(rs.find((r) => r.name === "POST /api/logout")?.status).toBe("fail");
  });

  it("fails the cookie check when Set-Cookie is missing", () => {
    const rs = checkLogout(200, undefined);
    expect(rs.find((r) => r.name.includes("Set-Cookie"))?.status).toBe("fail");
  });

  it("fails the cookie check when Set-Cookie does not clear the session (e.g. still carries a value)", () => {
    const rs = checkLogout(200, `${SESSION_COOKIE_NAME}=still-here; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`);
    expect(rs.find((r) => r.name.includes("Set-Cookie"))?.status).toBe("fail");
  });

  it("fails the cookie check when Max-Age=0 is missing", () => {
    const rs = checkLogout(200, `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/`);
    expect(rs.find((r) => r.name.includes("Set-Cookie"))?.status).toBe("fail");
  });

  // Never asserted anymore: replaying the old cookie after logout could legitimately still work
  // (the token is not revoked server-side, per apiHandlers.ts), so a fresh /api/status 401 is not
  // an honest signal either way and must not appear as a check here.
  it("never checks a follow-up /api/status call", () => {
    const rs = checkLogout(200, CLEARED);
    expect(rs.some((r) => r.name.includes("/api/status"))).toBe(false);
  });
});
