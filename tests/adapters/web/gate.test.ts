import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import { fakeDeps } from "../../support/fakeApiDeps";

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

// Every read (GET) route in the API. The brief only spot-checked one of these; the board is not
// public for any of them, so all nine are covered the same way the write routes are.
const readRoutes: [string, string][] = [
  ["GET", "/api/config"],
  ["GET", "/api/status"],
  ["GET", "/api/typefully/quota"],
  ["GET", "/api/publish/state"],
  ["GET", "/api/translations"],
  ["GET", "/api/renderings"],
  ["GET", "/api/renderings/x:1/announcement/telegram/emissions"],
  ["GET", "/api/renderings/x:1/announcement/telegram/emissions/tg-dev"],
  ["GET", "/api/items/x:1/board"],
];

/**
 * `login` is overridden to always succeed on both variants: the only test here that actually calls
 * it is "lets the login route through unauthenticated", and every other test in this file exercises
 * a route that never reaches `deps.login` at all (the gate answers first, or the route itself does
 * not touch it) — so the override cannot make any other assertion here pass for the wrong reason.
 */
function unauthenticatedDeps(): ApiDeps {
  return { ...fakeDeps(), session: undefined, login: async () => ({ ok: true }) };
}
function authenticatedDeps(): ApiDeps {
  return { ...fakeDeps(), session: { issuedAt: new Date().toISOString() }, login: async () => ({ ok: true }) };
}

describe("the gate", () => {
  it.each(writeRoutes)("refuses %s %s without a session", async (method, path) => {
    const result = await handleApi(unauthenticatedDeps(), method, path, {});
    expect(result.status).toBe(401);
  });

  it.each(writeRoutes)("reaches the route with a session: %s %s", async (method, path) => {
    const result = await handleApi(authenticatedDeps(), method, path, {});
    expect(result.status).not.toBe(401);
  });

  it.each(readRoutes)("refuses %s %s without a session — the board is not public", async (method, path) => {
    const result = await handleApi(unauthenticatedDeps(), method, path, undefined);
    expect(result.status).toBe(401);
  });

  it.each(readRoutes)("reaches the route with a session: %s %s", async (method, path) => {
    const result = await handleApi(authenticatedDeps(), method, path, undefined);
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

  /**
   * Logout is not exempt — only `POST /api/login` is. A caller with no session has none to end, and
   * the dashboard never shows a sign-out control without one anyway.
   */
  it("refuses logout without a session", async () => {
    const result = await handleApi(unauthenticatedDeps(), "POST", "/api/logout", undefined);
    expect(result.status).toBe(401);
  });

  it("reaches logout with a session", async () => {
    const result = await handleApi(authenticatedDeps(), "POST", "/api/logout", undefined);
    expect(result.status).toBe(200);
  });

  it("the 401 carries no detail about why", async () => {
    const result = await handleApi(unauthenticatedDeps(), "GET", "/api/translations", undefined);
    expect(result.json).toEqual({ error: "unauthenticated" });
  });
});
