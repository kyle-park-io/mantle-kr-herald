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
// So this file reads the source. It is the same approach `tests/deploy/apiRouting.test.ts` takes to
// the routing table and `tests/deploy/heraldDeploy.test.ts` takes to the deploy script, for the same
// reason: the thing being asserted is not reachable any other way.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

const SOURCE = join(REPO_ROOT, "src/cli/deploy-smoke.ts");

/**
 * The block guarded by `if (cookie) {` — every request made while logged in. It ends at the logout
 * call, which is the line that drops the cookie (`cookie = undefined`); nothing after that may send
 * one, and asserting over it would invert the rule.
 */
async function authenticatedBlock(): Promise<string> {
  const source = await readFile(SOURCE, "utf8");
  const start = source.indexOf("if (cookie) {");
  expect(start, "the `if (cookie) {` block has been renamed — this test needs updating").toBeGreaterThan(-1);
  const end = source.indexOf('request("/api/logout"', start);
  expect(end, "the logout call moved out of the authenticated block").toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every `request(...)` / `statusOf(...)` call in a chunk of source, as whole call expressions.
 *  Balanced-paren scan rather than a regex, because these calls contain nested object literals and
 *  calls of their own. */
function calls(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\b(?:request|statusOf)\(/g)) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    found.push(source.slice(match.index, i + 1));
  }
  return found;
}

describe("deploy:smoke's authenticated requests", () => {
  it("sends the session cookie with every request made after logging in", async () => {
    const block = await authenticatedBlock();
    const authenticated = calls(block);
    // A guard on the guard: if the calls stop being found, the assertion below passes vacuously.
    expect(authenticated.length).toBeGreaterThanOrEqual(3);
    for (const call of authenticated) {
      expect(call, `this call does not carry the session:\n${call}`).toContain("cookie");
    }
  });

  it("asks the liveness route for its report through that session", async () => {
    const block = await authenticatedBlock();
    const live = calls(block).filter((c) => c.includes("/api/diagnostics/live"));
    expect(live, "deploy:smoke no longer reads GET /api/diagnostics/live at all").toHaveLength(1);
    expect(live[0]).toContain("cookie");
  });
});
