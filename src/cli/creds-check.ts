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
import { describeValue, sanitizeWireText } from "../deploy/describeValue";
import { ALERT_MARKER } from "../deploy/alertMarker";
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

/**
 * Parsing is not addressing. `new URL("mailto:ops@example.com")` and `new URL("file:///etc/hosts")`
 * both succeed, and both have an `origin` of the *string* `"null"`; `ftp://example.com/x` parses to
 * a real-looking origin `fetch` still cannot use. Without this guard the client is built on that,
 * the first request fails as a network error, and the report tells the operator the deployment was
 * unreachable and exits 1 — a credential verdict for what is actually a misconfigured unit file. The
 * exit codes are a contract (`deploy/herald-creds.service`): 1 must mean go look at a credential.
 */
if (deployment.protocol !== "http:" && deployment.protocol !== "https:") {
  console.error(`Not an http(s) URL: ${rawUrl} — this command talks to a deployment over HTTP.`);
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

/**
 * Why `GET /api/status` could not answer whether sends are open, in the words an operator reading a
 * Telegram alert needs: which way it failed, and what that cost. `parsed` is the body as parsed, or
 * `undefined` when the parse itself failed — the two are different failures and are named
 * differently, because "your deployment returned an HTML error page" and "your deployment's status
 * payload lost a field" lead to entirely different places.
 */
function unreadableStatus(res: Response | undefined, parsed: unknown): string {
  const reason =
    res === undefined
      ? "never completed — the deployment could not be reached"
      : !res.ok
        ? `answered HTTP ${res.status}`
        : parsed === undefined
          ? `answered HTTP ${res.status} with a body that did not parse as JSON`
          : `answered HTTP ${res.status} with no boolean \`sendsEnabled\` field: ${describeValue(parsed)}`;
  return (
    `GET /api/status ${reason}, so the send tier could not be graded. A dead Typefully or Telegram ` +
    "credential is a warn while sends are closed and a fail once they are open, and this run could not " +
    "tell which — so the milder verdict below was not observed, it was merely the default. Not knowing " +
    "is not the same as being fine."
  );
}

/**
 * The names of everything that failed, on one bounded line, printed after `formatReport`'s counts.
 *
 * **This line is the only part of the report an alert is guaranteed to carry.**
 * `deploy/herald-notify-failure.sh` sends a five-line tail (`LOG_TAIL_LINES`) of the failing unit's
 * output, and `formatReport` puts the counts last, so with seven probes the `✗` line sits nine rows
 * from the end. Replaying the 2026-08-10 incident — only `google_auth` dead — through the real
 * wrapper and a copy of the real hook produced exactly this, and nothing else:
 *
 *     ⚠ herald-creds.service failed
 *       ✓ live: telegram               alive
 *       ✓ live: google_sheets          alive
 *
 *     6 ok · 0 warn · 1 fail
 *
 * Two green ticks and a count. With a mixed report it does not merely omit the cause, it misreports
 * it: the tail lands on whichever probes happen to be last and points the operator at those. The
 * spec's own sentence — "an alert that misreports its own cause is worse than no alert" — landing on
 * the path where every piece works.
 *
 * `deploy/herald-creds.service` is the first unit to hit this because the other three fail with a
 * stack trace at the END of their output, which is where a five-line tail looks.
 *
 * Fixed here rather than by widening `LOG_TAIL_LINES`: that tail is shared with three units whose
 * alerts are shaped around it, and one command's layout is not a reason to re-cut everyone's.
 *
 * **Printing it last is not what makes it arrive — the marker is.** Last-line-plus-a-five-line-tail
 * left one line of slack, and on the journal branch systemd's own failure lines spend all of it:
 * measured at position 1 of 5, so one more systemd line or one stray print empties the alert again.
 * Locating content by counting lines from the end is a positional heuristic, and this is the third
 * guard in this task to be defeated by one. So the line declares itself with `ALERT_MARKER` and
 * `deploy/herald-notify-failure.sh` carries marked lines whatever the tail depth. It is still
 * printed last, because that is where it reads best for a human tailing the log.
 *
 * Names only, no details — the details are three rows up in the same log, and the alert links it.
 * Bounded for the reason `describeValue` is bounded: seven dead probes, or a hostile body that
 * produces one `fail` per entry, must not put the whole report back on the last line. Whole names
 * are dropped rather than the line cut mid-word, because half a name is not a name anyone can grep.
 */
const FAILED_LINE_MAX = 200;
function failedLine(results: CheckResult[]): string | undefined {
  // Sanitized again here, even though `checkLiveness` already sanitizes the only wire-derived names
  // that reach this point. This function's entire contract is "one line", and a contract that holds
  // only because of what some other module currently does is the shape of guard this task has now
  // been caught by three times. For today's inputs this is a no-op; it is what keeps the contract
  // true for a `CheckResult` built somewhere that has not thought about it.
  const names = results.filter((r) => r.status === "fail").map((r) => sanitizeWireText(r.name));
  if (names.length === 0) return undefined;
  for (let shown = names.length; shown >= 1; shown--) {
    const dropped = names.length - shown;
    const line = `${ALERT_MARKER}✗ FAILED: ${names.slice(0, shown).join(", ")}${dropped > 0 ? ` (+${dropped} more)` : ""}`;
    if (line.length <= FAILED_LINE_MAX) return line;
  }
  // Even one name is over budget — a probe key long enough to be pathological. Still answer, still
  // bounded, and still say how many went unnamed rather than silently dropping them.
  const suffix = names.length > 1 ? ` (+${names.length - 1} more)` : "";
  return `${`${ALERT_MARKER}✗ FAILED: ${names[0]}`.slice(0, FAILED_LINE_MAX - suffix.length - 1)}…${suffix}`;
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
    /**
     * `sendsEnabled` decides whether a dead send credential is a warn or a fail, and it comes from
     * the deployment itself so the check tightens exactly when sends open.
     *
     * Which is why an unreadable answer here is its own `fail`, and was the bug this branch used to
     * hold: no `sendsEnabled` collapses to `false`, and `false` is exactly "sends are closed, so a
     * dead send credential is only a warn". The lenient verdict is the DEFAULT for a route that could
     * not be read, so the run where the answer mattered most — sends genuinely open, Telegram dead —
     * exited 0 with `6 ok · 1 warn · 0 fail` and told nobody. A 401, an HTML error page and a `{}`
     * body all did it.
     *
     * One `fail`, not `checkStatus()`'s seven. `deploy:smoke` grades that whole payload's shape; this
     * command deliberately does not, because a route-shape assertion firing at 06:23 is how an
     * operator learns to ignore the channel. This says the one thing that was lost.
     */
    const statusRes = await client.authed("/api/status");
    const statusBody: unknown = statusRes?.ok ? await statusRes.json().catch(() => undefined) : undefined;
    const sendsEnabled =
      typeof statusBody === "object" &&
      statusBody !== null &&
      typeof (statusBody as { sendsEnabled?: unknown }).sendsEnabled === "boolean"
        ? ((statusBody as { sendsEnabled: boolean }).sendsEnabled)
        : undefined;
    if (sendsEnabled === undefined) {
      results.push({ name: "sendsEnabled", status: "fail", detail: unreadableStatus(statusRes, statusBody) });
    }

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
    //
    // `sendsEnabled === true` deliberately treats an unknown answer as the lenient `false`, even
    // though the line above has just failed the run over not knowing it. Guessing `true` instead
    // would print `✗ live: telegram` — a severity nobody observed, on a credential that may be
    // perfectly fine — and the exit code is already settled by that `fail`. Report what was seen;
    // say separately that something was not.
    results.push(...checkLiveness(liveBody?.probes, sendsEnabled === true, liveRes?.status));
  }
} catch (err) {
  /**
   * **Kept, and deliberately not claimed to be unreachable. Do not delete this as dead code.**
   *
   * An earlier version of this comment traced every path above and concluded nothing could throw.
   * That was wrong, and it was wrong in the way worth remembering: `JSON.parse` is iterative and
   * accepts 100,000 levels of nesting, `JSON.stringify` is recursive and dies at a few thousand, so
   * a deployment could send a body that parsed fine and then blew the stack while a judging function
   * was describing it. Both routes did it — `probes` and `sendsEnabled` — and this `catch` dutifully
   * turned each into `✗ credential liveness … Maximum call stack size exceeded`, discarding the rest
   * of the report. Exit 1, an alert, and a message about this process's call stack rather than about
   * their deployment. The `catch` was not handling that failure, it was hiding it.
   *
   * So the fix went to the source: every wire value is now described through `describeValue`, which
   * cannot throw and is length-bounded, and two tests assert those bodies now produce a fail line
   * that NAMES the probe or the field and never mentions the call stack. This block no longer sees
   * them.
   *
   * What is left here is a backstop for the next input of that kind — the one nobody has thought of,
   * which is precisely the category a trace cannot enumerate, as the last trace proved. Deleting it
   * leaves the suite green; that means only that today's known inputs are handled at source, which
   * is where they should be handled. Without it, the next one costs the operator a Telegram alert
   * with a JavaScript error and no report attached, and a checker failure reads as a dead credential.
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

// One computation drives both, so "exit 1" and "the alert names what died" cannot come apart: the
// line is printed exactly when the exit code is 1, and nothing extra is printed when it is 0.
const failed = failedLine(results);
if (failed !== undefined) {
  console.log(failed);
  process.exitCode = 1;
}
