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
// A first version of this guard (fix round 1) checked a hardcoded list of four known authenticated
// paths, each matched only when it appeared as a string *literal* immediately inside `client.request(`.
// A reviewer broke it by building the exact regression it exists to catch:
//
//   const statusPath = "/api/status";
//   const statusRes = await client.request(statusPath); // no session sent
//
// All three tests in that version passed. Routing the same path through a variable defeated the
// literal-string match, and the separate `toContain("client.authed(")` check was satisfied trivially
// by any unrelated `authed()` call elsewhere in the file. The path list was also strictly narrower
// than the guard it replaced: the pre-refactor version scanned *every* call inside the textually
// scoped authenticated block, so a brand-new authenticated route added later was covered
// automatically; a hardcoded list of four paths is not.
//
// The round-1 fix dropped path matching entirely. The property that actually matters is not "these
// four routes use `authed()`" but "nothing inside the authenticated block bypasses `authed()`" — so
// it finds that block the same way the pre-refactor version did (textually, since `deploy-smoke.ts`
// cannot be imported and driven like an ordinary module — see below) and asserts every call inside
// it, regardless of what path expression it was given, is spelled `client.authed(`. That closed the
// reviewer's `client.request(statusPath)` bypass: caught because it is `client.request(`, not because
// of what `statusPath` holds.
//
// Two more bypasses followed, both silent 3/3 passes against that version:
//
//   const { request: rawRequest } = client;
//   const statusRes = await rawRequest("/api/status");                  <- not `client.request(` or
//                                                                           `client.authed(` textually
//
//   const decoyUrl = "http://example.com";
//   const statusRes = await client.request("/api/status");              <- a real, un-aliased bypass,
//                                                                           deleted from what this file
//                                                                           ever saw
// The first is a spelling this file's regex-driven `callsIn` cannot enumerate its way out of — a
// destructured reference calls the same function under a name this file never looks for, and there is
// no finite list of names to check against. The second is sharper: it is not an indirection at all,
// it is `client.request("/api/status")` written directly, but round 1's `stripLineComments` (added so
// this file's own narrative prose — which names `client.request(` while explaining what NOT to do —
// would not flag itself) truncated at the *first* `//` on the line, which was inside the decoy URL
// string, not at the start of an actual comment. The real, un-aliased bypass sat after that `//` and
// was cut from the text before `callsIn` ever ran, producing a false PASS from round 1's own
// mitigation.
//
// Two rounds each closing one textual bypass and revealing another is the signature of the wrong
// tool, not of an insufficiently clever regex: the property being guarded — no authenticated request
// leaves without a session — is a runtime fact, and source text cannot decide it, because the same
// request can always be spelled another way `callsIn` has not seen yet. The fix is not a third regex:
//
//   - `stripLineComments` is gone. It existed only because `deploy-smoke.ts`'s own comments spelled
//     out `client.request(`/`client.authed(` in prose; those comments were reworded (dropping the
//     trailing `(` — "the plain, unauthenticated `client.request` call" instead of "`client.request()`")
//     so they no longer look like the calls they describe, and the truncation bug goes with it rather
//     than being patched to be "safer".
//   - This file's checks stay — they are still real, still catch the literal-call-through-the-wrong-
//     helper case cheaply, in milliseconds, with no server or subprocess — but they are now a first,
//     fast signal, not the property's only guard. `tests/deploy/smokeSessionRuntime.test.ts` runs the
//     real `deploy-smoke.ts` as a subprocess against a hostile local server that 401s any gated route
//     reached without a real `herald_session` cookie — but it only sees a bypass whose response is
//     read by one of `smokeChecks.ts`'s judging functions; a bypassed call whose result nothing
//     consumes (`await client.request(path);` with no consumer) still gets a real 401 back but leaves
//     the printed report, and that test, unaffected. This file catches that case instead: it scans
//     source syntactically, so it flags a bypass call the moment it is written, whether or not its
//     result is ever consumed — but it is blind to a spelling it has not been taught (alias,
//     destructure, indirection), which the runtime test catches regardless of spelling. Neither guard
//     subsumes the other; deleting either because "the other one covers this" reopens exactly the hole
//     the deleted one closed.
//
// So this file still reads the source, for what source-reading can still usefully catch quickly. It
// is the same approach `tests/deploy/apiRouting.test.ts` takes to the routing table and
// `tests/deploy/heraldDeploy.test.ts` takes to the deploy script, for the same reason: `deploy-smoke.ts`
// cannot be imported and driven like an ordinary module, so reading it is the only way to check
// anything about it without actually running it — which is exactly what the runtime test now also does.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

const SOURCE = join(REPO_ROOT, "src/cli/deploy-smoke.ts");

/**
 * The block guarded by `if (client.loggedIn) {` — every call made while logged in. Found by brace
 * balancing rather than a second textual endpoint (the pre-refactor version located the end by
 * searching for the logout call by name, which ties the guard to one specific call surviving under
 * one specific spelling). A brace-balanced scan finds the block's real end regardless of what is
 * inside it, so a call added, removed, or reordered inside the block never breaks the extraction
 * itself — only the assertions below judge what is in there.
 *
 * Fails loudly, not silently, if the anchor is gone: an anchor that quietly matches nothing would
 * make `slice(...)` return an empty or wrong string, every assertion below would pass vacuously over
 * it, and the guard would stop guarding without a single red test — the same failure shape Task 1's
 * own review flagged for `authed()` itself.
 */
function authenticatedBlock(source: string): string {
  const marker = "if (client.loggedIn) {";
  const markerAt = source.indexOf(marker);
  expect(markerAt, "the `if (client.loggedIn) {` block has been renamed or removed — this test needs updating").toBeGreaterThan(-1);
  const braceStart = markerAt + marker.length - 1; // the `{` the marker itself ends on
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  expect(i, "the `if (client.loggedIn) { ... }` block never closes — brace scan ran off the end of the file").toBeLessThan(
    source.length,
  );
  return source.slice(braceStart + 1, i);
}

/** Every `client.request(...)` / `client.authed(...)` / `statusOf(...)` call in a chunk of source, as
 *  whole call expressions. Balanced-paren scan rather than a regex, because these calls contain
 *  nested object literals and calls of their own. Deliberately does not look at the argument each
 *  call was given — the point of this guard is that the *helper* used inside the authenticated block
 *  is what matters, not what path expression (literal, variable, or otherwise) was passed to it.
 *
 *  Scans raw source, comments included. This file used to strip `//` comments first, to keep its own
 *  prose about `client.request(` from matching; that stripping was naive (`indexOf("//")` cuts at the
 *  first occurrence, including one inside a string literal earlier on the same line) and produced a
 *  false PASS by deleting a real bypass from the text before this function ever ran it. The fix was
 *  to stop needing to strip anything: `deploy-smoke.ts`'s own comments were reworded so none of them
 *  contain the literal substring `client.request(` / `client.authed(` / `statusOf(` — see that file's
 *  authenticated block. A comment that merely mentions "the plain, unauthenticated `client.request`
 *  call" (no trailing paren) does not match the regex below and needs no stripping to stay that way. */
function callsIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\b(?:client\.request|client\.authed|statusOf)\(/g)) {
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
  it("makes every call inside the authenticated block go through client.authed()", async () => {
    // The 2026-08-10 Critical was one authenticated call that forgot the cookie. `authed()` now
    // attaches it, so the way to reintroduce that bug — under any indirection, not just a literal
    // path string — is to bypass `authed()` inside this block. This is what that looks like, and it
    // fails here regardless of how the path was spelled.
    const source = await readFile(SOURCE, "utf8");
    const block = authenticatedBlock(source);
    const calls = callsIn(block);
    // A guard on the guard: if the calls stop being found at all, the loop below passes vacuously.
    expect(calls.length, "no calls found inside the authenticated block — the block moved or emptied out").toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call, `this call inside the authenticated block does not go through client.authed():\n${call}`).toMatch(
        /^client\.authed\(/,
      );
    }
  });

  it("asks the liveness route for its report through the session client", async () => {
    const source = await readFile(SOURCE, "utf8");
    const block = authenticatedBlock(source);
    const live = callsIn(block).filter((c) => c.includes("/api/diagnostics/live"));
    expect(live, "deploy:smoke no longer reads GET /api/diagnostics/live at all").toHaveLength(1);
    expect(live[0]).toMatch(/^client\.authed\(/);
  });

  it("drops the session after logging out", async () => {
    // The other half of the original incident's lesson: a session that outlives its logout call is
    // as dangerous as one that never gets attached. `client.forgetSession()` is the only place that
    // can happen now that the cookie is not a local variable this file can reset by hand.
    const source = await readFile(SOURCE, "utf8");
    expect(source).toContain("client.forgetSession()");
  });
});
