// tests/deploy/smokeSession.test.ts
//
// `src/cli/deploy-smoke.ts` is a top-level script — it runs on import, prompts for a password and
// makes HTTP calls, so it cannot be imported into a test. Its judgement lives in
// `src/deploy/smokeChecks.ts` (unit-tested there) and what is left here is transport. That transport
// is not, however, beyond checking, and it held a bug that no unit test could ever have caught:
//
//   const liveRes = await request("/api/diagnostics/live");            <- no session
//
// `GET /api/diagnostics/live` is session-gated like every route but `POST /api/login`
// (`apiHandlers.ts`), so it answered 401, `probes` came back `undefined`, and `checkLiveness`
// reported its "route unreadable" FAIL on every single run — including runs where every credential
// was alive. The feature had never once executed. Both sides were individually correct and fully
// tested; only the wiring between them was wrong, and only reading the wiring finds that.
//
// `deploy-smoke.ts` now gets its session from `../../src/deploy/deploymentSession.ts`'s
// `DeploymentClient`: `client.authed(path, init?)` attaches the session cookie itself, so an
// authenticated call that forgets it is no longer something a call site can spell. That makes the
// original assertion here — "every authenticated call contains the text `cookie`" — unrepresentable
// rather than merely unwritten: there is no `cookie` in the source for a correct call to contain
// anymore. The bug this file now guards against is the same one, one level up the stack: a call to a
// session-gated route made through `client.request()` (the unauthenticated escape hatch) instead of
// `client.authed()`. That is what a reintroduction of the 2026-08-10 Critical would look like today,
// and it is still readable from the source alone, the same way the old bug was.
//
// So this file still reads the source. It is the same approach `tests/deploy/apiRouting.test.ts`
// takes to the routing table and `tests/deploy/heraldDeploy.test.ts` takes to the deploy script, for
// the same reason: the thing being asserted is not reachable any other way — `deploy-smoke.ts` cannot
// be imported and driven like an ordinary module.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

const SOURCE = join(REPO_ROOT, "src/cli/deploy-smoke.ts");

describe("deploy:smoke's authenticated requests", () => {
  it("makes no authenticated call through the raw request helper", async () => {
    // The 2026-08-10 Critical was one authenticated call that forgot the cookie. `authed()` now
    // attaches it, so the way to reintroduce that bug is to bypass `authed()` and call
    // `client.request()` for a route that needs a session. This is what that would look like, and it
    // fails here.
    const source = await readFile(SOURCE, "utf8");
    const authedPaths = ["/api/status", "/api/diagnostics/live", "/api/logout", "/api/items/"];
    for (const path of authedPaths) {
      const viaRequest = new RegExp(String.raw`client\.request\(\s*["'\`][^"'\`]*${path.replace(/\//g, "\\/")}`);
      expect(source, `${path} must go through client.authed(), not client.request()`).not.toMatch(viaRequest);
    }
    expect(source).toContain("client.authed(");
  });

  it("asks the liveness route for its report through the session client", async () => {
    const source = await readFile(SOURCE, "utf8");
    expect(source, "deploy:smoke no longer reads GET /api/diagnostics/live at all").toContain(
      'client.authed("/api/diagnostics/live")',
    );
  });

  it("drops the session after logging out", async () => {
    // The other half of the original incident's lesson: a session that outlives its logout call is
    // as dangerous as one that never gets attached. `client.forgetSession()` is the only place that
    // can happen now that the cookie is not a local variable this file can reset by hand.
    const source = await readFile(SOURCE, "utf8");
    expect(source).toContain("client.forgetSession()");
  });
});
