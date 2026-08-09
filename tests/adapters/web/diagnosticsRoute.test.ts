// tests/adapters/web/diagnosticsRoute.test.ts
//
// The route exists because liveness is observable from exactly one place — inside the deployment,
// where the credential is. Two properties matter and neither is obvious from the handler:
// it answers 200 with a report even when every probe is dead (a diagnostic that 500s when something
// is wrong tells you nothing), and it is behind the session like every route but login.
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { LiveProbeResult } from "../../../src/doctor/liveProbes";
import { fakeDeps } from "../../support/fakeApiDeps";

const ALL_DEAD: LiveProbeResult[] = [
  { key: "google_auth", status: "dead", detail: "Google OAuth token refresh failed: HTTP 400" },
  { key: "telegram", status: "skipped", detail: "not configured — TELEGRAM_BOT_TOKEN unset" },
];

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    ...fakeDeps(),
    // Authenticated by default — the 401 test below overrides this back to `undefined` explicitly,
    // the same "session set here is what lets it through" pattern `loginRoute.test.ts`'s
    // `authenticatedDeps()` uses.
    session: { issuedAt: new Date().toISOString() },
    probeLiveness: async () => ALL_DEAD,
    ...overrides,
  };
}

describe("GET /api/diagnostics/live", () => {
  it("answers 200 with the report even when a probe is dead", async () => {
    const res = await handleApi(deps(), "GET", "/api/diagnostics/live", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ probes: ALL_DEAD });
  });

  /**
   * The 401 alone is half the assertion. What must not happen is the probes RUNNING for an
   * unauthenticated caller — every one of them spends a live credential against a third-party API,
   * and a gate that answers 401 after doing the work is a free way to make the deployment refresh
   * its Google token and hit Typefully's rate limit on demand. `probeLiveness` throwing is the only
   * way to see the difference from out here: the 401 is identical either way.
   */
  it("requires a session, and does not run a single probe without one", async () => {
    const res = await handleApi(
      deps({
        session: undefined,
        probeLiveness: async () => {
          throw new Error("must not run");
        },
      }),
      "GET",
      "/api/diagnostics/live",
      undefined,
    );
    expect(res.status).toBe(401);
  });

  it("does not answer other methods", async () => {
    const res = await handleApi(deps(), "POST", "/api/diagnostics/live", undefined);
    expect(res.status).toBe(404);
  });
});
