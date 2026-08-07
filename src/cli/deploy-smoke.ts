import "./registerErrorHandler";
import { stdin, stderr } from "node:process";
import { ask } from "./prompt";
import { smokeCredentials } from "./smokeCredentials";
import { formatReport, type CheckResult } from "../doctor/report";
import {
  checkAnonymous,
  checkLogin,
  checkCredentials,
  checkStatus,
  checkConvertPrepare,
  checkLogout,
  type StatusPayload,
} from "../deploy/smokeChecks";

/**
 * `pnpm deploy:smoke <url>` — run against a deployment once it is up, to prove the thing that
 * landed actually behaves correctly. `deploy:check`'s sibling (`src/cli/deploy-check.ts`): same
 * `CheckResult`/`formatReport` shape, same `process.exitCode = 1` ending. Unlike `deploy:check`,
 * which never leaves this machine, everything here is an HTTP request to the deployment itself —
 * the judgement stays in `src/deploy/smokeChecks.ts` (pure, unit-tested); this file is the thin,
 * unread transport that gathers a status code or a parsed body and hands it to one of those
 * functions, the same split `readStatic` (`src/cli/staticFiles.ts`) already uses.
 *
 * **Calls no outlet route.** The only POSTs this file ever makes are `/api/login`, `/api/logout`,
 * and a `convert-prepare` probe the hosted route set answers 404 to before touching anything — see
 * the spec's "What it does not do".
 */

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const lockout = process.argv.includes("--lockout");
const rawUrl = positional[0];

if (!rawUrl) {
  console.error("Usage: pnpm deploy:smoke <url> [--lockout]");
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
 * Scheme + host only — no trailing slash, no path. This is the exact shape `isAllowedOrigin`
 * compares an `Origin` header against on both entry points it guards (`HttpServer.ts`'s
 * `isLoopbackOrigin` and `api/[...path].ts`'s `loadDeploymentOrigin`-built predicate), so building
 * it from the parsed `URL` rather than reusing `rawUrl` verbatim means a trailing slash or a stray
 * path segment the operator typed can never turn a legitimate deployment into a "foreign" one.
 * Every state-changing request below sends this as `Origin`, or the CSRF guard refuses it before it
 * ever reaches a route.
 */
const origin = deployment.origin;

const results: CheckResult[] = [];

/** One HTTP call, or `undefined` on a network failure (deployment unreachable, DNS, connection
 *  refused) — printed once here rather than thrown, so a dead deployment produces a report with
 *  clearly-failing checks instead of a stack trace partway through this file. */
async function request(path: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(`${origin}${path}`, init);
  } catch (err) {
    console.error(`  (request to ${path} failed: ${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/** `request`, reduced to a status code — `-1` on a network failure, a code none of `smokeChecks.ts`'s
 *  functions ever treat as a pass, so the failure still shows up in the report rather than vanishing. */
async function statusOf(path: string, init?: RequestInit): Promise<number> {
  const res = await request(path, init);
  return res?.status ?? -1;
}

// --- before logging in (spec: "Before logging in") ---

const root = await statusOf("/");
const anonymousStatus = await statusOf("/api/status");
// Deliberately the one foreign Origin in this whole file — every other state-changing request below
// sends `origin` (this deployment's own). No login is actually attempted: `refusalReason` refuses a
// mismatched Origin before a route, or the request body, is ever read.
const foreignOrigin = await statusOf("/api/login", {
  method: "POST",
  headers: { origin: "https://evil.example", "content-type": "application/json" },
  body: JSON.stringify({ username: "probe", password: "probe" }),
});
results.push(...checkAnonymous({ root, status: anonymousStatus, foreignOrigin }));

// --- logging in (spec: "Logging in") ---

/** Same helper shape `src/cli/auth-hash.ts` already uses over the same `ask`. */
const prompt = (question: string, hidden = false) => ask(question, { hidden, input: stdin, output: stderr });

// Environment first, prompt as the interactive fallback — see `smokeCredentials` for why the
// half-configured case refuses instead of falling through to a prompt that would hang a CI runner.
const source = smokeCredentials({
  HERALD_SMOKE_USERNAME: process.env.HERALD_SMOKE_USERNAME,
  HERALD_SMOKE_PASSWORD: process.env.HERALD_SMOKE_PASSWORD,
});
if (source.kind === "refuse") throw new Error(source.reason);
const username = source.kind === "env" ? source.username : (await prompt("Username: ")).trim();
const password = source.kind === "env" ? source.password : await prompt("Password: ", true);

// Judged before the request. An empty entry cannot log in, and sending it anyway would spend one of
// the five attempts this address gets per minute — see `checkCredentials`.
const credentials = checkCredentials(username, password);
results.push(credentials);

const loginRes =
  credentials.status === "ok"
    ? await request("/api/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
    : undefined;
if (credentials.status === "ok") results.push(checkLogin(loginRes?.status ?? -1));

// The session cookie, carried through every authenticated request below and dropped the moment
// logout is called — never re-derived, so this file can never accidentally send a stale one.
let cookie: string | undefined;
if (loginRes?.status === 200) {
  cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
}

// --- after logging in (spec: "After logging in") ---
//
// Skipped entirely without a cookie — a wrong password or a 403 already failed `checkLogin` above,
// and every check below needs a real session to mean anything.
if (cookie) {
  const statusRes = await request("/api/status", { headers: { cookie } });
  const payload = (statusRes ? await statusRes.json().catch(() => undefined) : undefined) as StatusPayload;
  results.push(...checkStatus(payload));

  const convertPrepareCode = await statusOf("/api/items/deploy-smoke-probe/convert-prepare", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie },
  });
  results.push(checkConvertPrepare(convertPrepareCode));

  const logoutRes = await request("/api/logout", { method: "POST", headers: { origin, cookie } });
  cookie = undefined; // the whole point of logging out: nothing sent after this line carries it
  results.push(...checkLogout(logoutRes?.status ?? -1, logoutRes?.headers.get("set-cookie") ?? undefined));
}

// --- lockout, opt-in (spec: "What it does not do") ---
//
// Off by default: five failed logins lock this deployment's login for sixty seconds, and running it
// on every `deploy:smoke` would lock the team out of the production dashboard while they may be
// using it. `checkLogin` is not reused here — it treats anything but 200 as a plain failure, and 429
// is the PASSING outcome for this specific probe.
if (lockout) {
  let lastCode = -1;
  for (let i = 0; i < 5; i++) {
    lastCode = await statusOf("/api/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "deploy-smoke-deliberately-wrong-password" }),
    });
  }
  results.push(
    lastCode === 429
      ? {
          name: "POST /api/login x5 (--lockout)",
          status: "ok",
          detail: "429 after 5 failed attempts — the per-IP lockout is enforced.",
        }
      : {
          name: "POST /api/login x5 (--lockout)",
          status: "fail",
          detail: `Expected 429 after 5 failed attempts, got ${lastCode} — the per-IP lockout is not enforced.`,
        },
  );
} else {
  results.push({
    name: "POST /api/login x5 (--lockout)",
    status: "warn",
    detail: "Skipped — pass --lockout to verify; it locks this deployment's login for 60 seconds.",
  });
}

console.log(formatReport(results, { title: "Mantle KR Herald — deploy smoke" }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
