/**
 * Asks a deployment whether its own credentials still work, and exits non-zero when a publishing
 * one does not. Built to be run by `deploy/herald-creds.timer`, which is why it never prompts.
 *
 * `pnpm deploy:smoke` answers a different question — is this deployment correctly shaped and
 * reachable — with twenty-odd checks, most of which have nothing to do with credentials. Running
 * that on a timer would alert on a route-shape assertion at 06:23 and teach the operator to ignore
 * the channel, so this command does one thing.
 *
 * **Exit codes are a contract** (`deploy/herald-creds.service` and its test depend on them):
 * 0 nothing failed, 1 something failed, 2 usage or configuration error — a run that never got as far
 * as asking the question. The distinction matters under the timer: 2 means fix this machine's
 * configuration, 1 means fix a credential.
 *
 * **Every failure reaching the operator is a report line.** The one thing an unattended command must
 * never do is fail in a way that does not say what failed — that is the disease this whole feature
 * treats. So the probe runs inside a `try` whose `catch` turns anything thrown into a `fail` result
 * printed through `formatReport`. `registerErrorHandler` stays imported (it also installs
 * `preferIpv4`, which every network command wants) but is now the backstop rather than the path a
 * foreseeable failure takes: its output names a JavaScript error, which tells an operator reading a
 * Telegram alert nothing about their credentials.
 */
import "./registerErrorHandler";
import { createDeploymentClient } from "../deploy/deploymentSession";
import { checkLiveness } from "../deploy/smokeChecks";
import { smokeCredentials } from "./smokeCredentials";
import { formatReport, type CheckResult } from "../doctor/report";

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const rawUrl = positional[0] ?? process.env.HERALD_DEPLOYMENT_ORIGIN?.trim();

if (!rawUrl) {
  console.error("Usage: pnpm creds:check <url>   (or set HERALD_DEPLOYMENT_ORIGIN)");
  process.exit(2);
}

let deployment: URL;
try {
  deployment = new URL(rawUrl);
} catch {
  console.error(`Not a valid URL: ${rawUrl}`);
  process.exit(2);
}

// Scheme + host only, the shape the deployment's CSRF guard compares an `Origin` against.
const client = createDeploymentClient(deployment.origin);

// No prompt fallback, unlike `deploy:smoke`. A timer has no stdin: prompting blocks until
// TimeoutStartSec kills the unit, and the operator then gets a Telegram alert saying a credential
// check failed when the check never ran. Refuse, name the variables, and exit.
const source = smokeCredentials({
  HERALD_SMOKE_USERNAME: process.env.HERALD_SMOKE_USERNAME,
  HERALD_SMOKE_PASSWORD: process.env.HERALD_SMOKE_PASSWORD,
});
if (source.kind !== "env") {
  console.error(
    source.kind === "refuse"
      ? source.reason
      : "HERALD_SMOKE_USERNAME and HERALD_SMOKE_PASSWORD must both be set — this command runs unattended and never prompts.",
  );
  process.exit(2);
}

const results: CheckResult[] = [];

try {
  const loginStatus = await client.logIn(source.username, source.password);
  if (loginStatus !== 200) {
    results.push({
      name: "login",
      status: "fail",
      detail: `POST /api/login answered ${loginStatus === -1 ? "nothing — the deployment was unreachable" : loginStatus}.`,
    });
  } else if (!client.loggedIn) {
    /**
     * A 200 that carries no `Set-Cookie` — a deployment behind a proxy that strips it, or a login
     * route that regressed. `logIn` reports 200 and there is still no session, so every `authed()`
     * call below would throw. Branching on `client.loggedIn` rather than on the status code alone is
     * what keeps that from being the way this command finds out.
     */
    results.push({
      name: "login",
      status: "fail",
      detail:
        "POST /api/login answered 200 but sent no session cookie, so nothing authenticated could be asked of " +
        "this deployment. Not the same as the credentials being alive, so this is a failure rather than a pass.",
    });
  } else {
    // `sendsEnabled` decides whether a dead send credential is a warn or a fail, and it comes from the
    // deployment itself so the check tightens exactly when sends open.
    const statusRes = await client.authed("/api/status");
    const statusBody = (statusRes ? await statusRes.json().catch(() => undefined) : undefined) as
      | { sendsEnabled?: boolean }
      | undefined;

    // Through `client.authed`, never the plain unauthenticated escape hatch: this route is
    // session-gated like every route but `/api/login`, and a call that reached it without the cookie
    // would get a 401, hand `checkLiveness` an `undefined` `probes`, and report "the route could not
    // be read" on every run — including runs where every credential is perfectly alive. That is the
    // 2026-08-10 incident verbatim (see `../deploy/deploymentSession.ts`'s header). Both of this
    // file's authenticated calls are held to carrying a session at runtime by
    // `tests/cli/credsCheck.test.ts`, whose stub 401s anything cookie-less.
    const liveRes = await client.authed("/api/diagnostics/live");
    // `.catch(() => undefined)` on the parse: a non-JSON body (a gateway error page, say) must fall
    // into checkLiveness's "route unreadable" path, not end the command in a parse error.
    const liveBody = (liveRes && liveRes.ok ? await liveRes.json().catch(() => undefined) : undefined) as
      | { probes?: unknown }
      | undefined;

    // The status code is passed so an unreadable route can say WHICH way it was unreadable.
    results.push(...checkLiveness(liveBody?.probes, statusBody?.sendsEnabled === true, liveRes?.status));
  }
} catch (err) {
  /**
   * Nothing above is expected to throw — `request()` swallows network failures and both JSON parses
   * are guarded — so this is for the unforeseen. It exists because the alternative is worse than a
   * generic message: an escaping rejection would print a JavaScript error and exit, the operator
   * would get the alert with no report attached, and the check would look like the deployment
   * failing rather than the checker failing.
   */
  results.push({
    name: "credential liveness",
    status: "fail",
    detail:
      `The check itself failed before it could judge anything: ${err instanceof Error ? err.message : String(err)}. ` +
      "Nothing about the deployment's credentials was established, so this is a failure rather than a pass.",
  });
}

console.log(formatReport(results, { title: `Mantle KR Herald — credential liveness (${client.origin})` }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
