import { describe, it, expect } from "vitest";
import {
  checkAnonymous, checkLogin, checkCredentials, checkStatus, checkConvertPrepare, checkLogout,
  checkLiveness,
  type StatusPayload,
} from "../../src/deploy/smokeChecks";
import type { LiveProbeResult, ProbeKey } from "../../src/doctor/liveProbes";
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

  /**
   * `Expected 200, got 401.` was all this said, and 401 is by far the most likely failure: it is
   * every wrong password, and the deployment answers it identically for an empty one, a one-character
   * one, and a wrong twelve-character one. An operator trying those three in a row sees the same line
   * three times and reasonably concludes the prompt is not reading their input.
   */
  it("says what 401 means, and that attempts are rationed", () => {
    const r = checkLogin(401);
    expect(r.detail).toMatch(/아이디|비밀번호|username|password/i);
    // The thing they cannot see coming: five wrong tries locks the address for a minute.
    expect(r.detail).toMatch(/5|five/);
  });

  it("names the lockout on 429 instead of reporting it as an unexpected code", () => {
    const r = checkLogin(429);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/60|잠긴|locked/i);
    expect(r.detail).not.toMatch(/^Expected 200/);
  });

  it("still reports an unexpected code plainly", () => {
    expect(checkLogin(500).detail).toMatch(/500/);
  });
});

describe("checkCredentials", () => {
  it("passes when both were typed", () => {
    expect(checkCredentials("mantle-kr", "a-real-password").status).toBe("ok");
  });

  /**
   * Refused locally, before the request. An empty password cannot succeed, and sending it would
   * spend one of the five attempts the deployment allows per minute per address — the operator would
   * be a fifth of the way to locking themselves out of production for nothing.
   */
  it("refuses an empty password without spending an attempt", () => {
    const r = checkCredentials("mantle-kr", "");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/보내지 않았|not sent|sent nothing/i);
  });

  it("refuses an empty username the same way", () => {
    expect(checkCredentials("", "a-real-password").status).toBe("fail");
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

const probe = (key: ProbeKey, status: LiveProbeResult["status"]): LiveProbeResult => ({ key, status, detail: `${key} ${status}` });

/**
 * Every key `runLiveProbes` emits, in its fixed order. Tests below build a WHOLE report and flip the
 * one probe under test, because `checkLiveness` now judges the report's membership as well as each
 * entry: a partial array is itself a failure (see "fails a report that is missing a probe"), so a
 * one-element array would no longer isolate the thing these tests mean to isolate.
 */
const ALL_KEYS: ProbeKey[] = [
  "google_auth",
  "google_drive_review",
  "google_drive_approved",
  "google_sheets",
  "lark",
  "typefully",
  "telegram",
];

/** A full report with every probe `ok`, then `overrides` applied. */
const report = (overrides: Partial<Record<ProbeKey, LiveProbeResult["status"]>> = {}): LiveProbeResult[] =>
  ALL_KEYS.map((key) => probe(key, overrides[key] ?? "ok"));

/** The one check named for a given probe key. */
const forKey = (rs: CheckResultLike[], key: ProbeKey): CheckResultLike => {
  const found = rs.find((r) => r.name === `live: ${key}`);
  expect(found, `no check for ${key}`).toBeDefined();
  return found as CheckResultLike;
};

describe("checkLiveness", () => {
  it("passes everything when every probe is ok", () => {
    const rs = checkLiveness(report(), false);
    expect(rs).toHaveLength(ALL_KEYS.length);
    expect(rs.every((r) => r.status === "ok")).toBe(true);
  });

  // The Drive probe is two keys, not one — a broken review folder and a broken approved folder are
  // distinguishable by name (liveProbes.ts). Both are publishing credentials and both must fail.
  it("fails a dead publishing credential — that is what this deployment is for", () => {
    for (const key of ["google_auth", "google_drive_review", "google_drive_approved", "lark"] as const) {
      const rs = checkLiveness(report({ [key]: "dead" }), false);
      expect(forKey(rs, key).status, key).toBe("fail");
    }
  });

  it("warns on a dead send credential while sends are closed", () => {
    for (const key of ["telegram", "typefully"] as const) {
      expect(forKey(checkLiveness(report({ [key]: "dead" }), false), key).status, key).toBe("warn");
    }
  });

  it("fails the same credential once sends are open", () => {
    // The flag comes from the same status payload, so the check tightens exactly when sends open
    // rather than on a second decision someone has to remember.
    for (const key of ["telegram", "typefully"] as const) {
      expect(forKey(checkLiveness(report({ [key]: "dead" }), true), key).status, key).toBe("fail");
    }
  });

  it("only ever warns about the Sheet — it is header links — sends open", () => {
    expect(forKey(checkLiveness(report({ google_sheets: "dead" }), true), "google_sheets").status).toBe("warn");
  });

  // Companion to the above: the Sheet's severity does not depend on `sendsEnabled` at all, so it
  // must warn identically with sends closed too — it is not merely "not yet tightened", it never
  // tightens, because a Sheet credential is not `"send"`-tiered in the first place.
  it("only ever warns about the Sheet — it is header links — sends closed too", () => {
    expect(forKey(checkLiveness(report({ google_sheets: "dead" }), false), "google_sheets").status).toBe("warn");
  });

  it("treats an unconfigured probe as ok, never as a failure", () => {
    // Presence is deploy:check's job. A Telegram-only install must not go red over Lark Drive.
    const rs = checkLiveness(report({ lark: "skipped", typefully: "skipped" }), true);
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

  /**
   * The failure that shipped: `deploy:smoke` called the session-gated route with no cookie, got 401,
   * and printed the "old deployment without the route" line on every run — including runs where every
   * credential was alive. Both halves of the fix are pinned: the caller sends the cookie
   * (tests/deploy/smokeSession.test.ts), and the message that appears when it does not says which of
   * the two things actually happened.
   */
  it("names a 401 as a missing session, not as a missing route", () => {
    const rs = checkLiveness(undefined, false, 401);
    expect(rs[0].status).toBe("fail");
    expect(rs[0].detail).toContain("401");
    expect(rs[0].detail).toMatch(/session/i);
  });

  /**
   * Measured before the fix: `checkLiveness([], false)` returned `[]` — zero checks, therefore zero
   * fails, therefore a clean exit for a deployment that reported nothing at all. The plan's own
   * self-review named this case and then fixed only the `undefined` half.
   */
  it("fails an empty report rather than reporting nothing", () => {
    const rs = checkLiveness([], false);
    expect(rs.some((r) => r.status === "fail")).toBe(true);
    for (const key of ALL_KEYS) expect(rs.map((r) => r.detail).join(" "), key).toContain(key);
  });

  it("fails a report that is missing a probe, and names which", () => {
    // A one-probe array used to mention that probe and never notice Google was absent.
    const rs = checkLiveness([probe("telegram", "ok")], false);
    const missing = rs.filter((r) => r.status === "fail");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("google_auth");
    expect(missing[0].detail).not.toContain("telegram");
  });

  /**
   * A 200 body is not a well-formed body. `{"probes": "x"}` used to reach `.map` on a string, throw a
   * TypeError out of a pure judging function, and end `deploy:smoke` in a stack trace through
   * `registerErrorHandler` — the one outcome a check that exists to REPORT failures must never have.
   */
  it("fails rather than throws when `probes` is not an array", () => {
    for (const body of ["x", 42, {}, true]) {
      const rs = checkLiveness(body, false, 200);
      expect(rs, JSON.stringify(body)).toHaveLength(1);
      expect(rs[0].status, JSON.stringify(body)).toBe("fail");
    }
  });

  it("fails the one malformed entry without discarding the rest of the report", () => {
    const rs = checkLiveness([...report(), null, { key: "google_auth" }], false);
    expect(rs.filter((r) => r.status === "fail")).toHaveLength(2);
    // Every real probe still got judged on its own merits.
    for (const key of ALL_KEYS) expect(forKey(rs, key).status, key).toBe("ok");
  });

  it("fails loudly on a key PROBE_TIER never classified, rather than defaulting to warn", () => {
    // "future_probe" is not a real ProbeKey — `PROBE_TIER`'s `Record<ProbeKey, ...>` makes every
    // real key a compile error to leave unclassified, so the only way this branch is reached at
    // runtime is a key that escaped the type system: a hand-built LiveProbeResult (as here), or a
    // live deployment one probe ahead of the `deploy:smoke` build reading it. `as ProbeKey` is a
    // deliberate lie to the type system, standing in for that future/unknown probe.
    const rs = checkLiveness([...report(), probe("future_probe" as ProbeKey, "dead")], false);
    expect(forKey(rs, "future_probe" as ProbeKey).status).toBe("fail");
  });

  /** A deployment one probe AHEAD of this build is not a broken one: the unknown key is judged (above),
   *  and the seven this build knows about are all present, so nothing is reported missing. */
  it("does not report a missing probe when the report merely carries an extra one", () => {
    const rs = checkLiveness([...report(), probe("future_probe" as ProbeKey, "ok")], false);
    expect(rs.every((r) => r.status === "ok")).toBe(true);
  });
});
