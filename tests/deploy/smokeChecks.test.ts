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
      integrations: [{ label: "Google Drive", configured: false }, { label: "Telegram", configured: true }],
    });
    expect(rs.some((r) => r.detail.includes("Google Drive"))).toBe(true);
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
  it("wants 401 after the session is cleared", () => {
    expect(checkLogout(401).status).toBe("ok");
    expect(checkLogout(200).status).toBe("fail");
  });
});
