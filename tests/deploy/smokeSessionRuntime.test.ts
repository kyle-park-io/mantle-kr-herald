// tests/deploy/smokeSessionRuntime.test.ts
//
// `smokeSession.test.ts` reads `src/cli/deploy-smoke.ts` as text and checks that every call inside
// the authenticated block is spelled `client.authed(...)`. Two rounds of review each found a real
// bypass that guard missed while still passing 3/3: one routed a gated path through a variable
// (`client.request(statusPath)`), one aliased `client.request` itself via destructuring
// (`const { request: rawRequest } = client`), and one was a real, un-aliased bypass that a text-
// truncation bug in the guard's own machinery deleted from the text before it was ever scanned. Full
// story in `smokeSession.test.ts`'s header.
//
// The pattern across all three is the same: the property this file cares about — no authenticated
// request ever leaves `deploy-smoke.ts` without a session — is a fact about what actually crosses the
// network, and source text is not that fact. It is, at best, evidence for it, and evidence a
// determined-enough rewrite can always falsify: there is no finite list of ways to spell "call this
// function" for a regex to enumerate.
//
// So this file does not read source at all. It runs the real, unmodified `deploy-smoke.ts` — via
// `tsx`, the same binary `pnpm deploy:smoke` uses — as a subprocess, pointed at a *hostile* local
// stub server: one that does not trust the caller to have attached a session correctly, and answers
// every gated route with a real 401 unless a request actually carries a real `herald_session` cookie.
// Whatever a bypass is spelled like, the request it sends either carries that cookie or it does not;
// the stub does not care how the caller's source got there. A bypass under any spelling — a variable,
// an alias, a destructured reference, one nobody has thought of yet — produces a real unauthenticated
// request, a real 401 from the stub, and a real failing check in the report `deploy-smoke.ts` prints,
// because that is what a 401 on a gated route has always meant to `smokeChecks.ts`'s judging
// functions (`checkStatus`, `checkLiveness`, `checkConvertPrepare`, `checkLogout`) — see that module
// for how each one grades it.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DEPLOY_SMOKE_ENTRY = join(REPO_ROOT, "src", "cli", "deploy-smoke.ts");

// Duplicated from `src/adapters/web/sessionCookie.ts` rather than imported: this stub's whole job is
// to behave like an independent, hostile deployment that does not share code — let alone trust — with
// the process it is testing.
const SESSION_COOKIE_NAME = "herald_session";

const servers: Server[] = [];
afterEach(() => servers.forEach((s) => s.close()));

function hasSession(req: IncomingMessage): boolean {
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").some((part) => {
    const t = part.trim();
    return t.startsWith(`${SESSION_COOKIE_NAME}=`) && t !== `${SESSION_COOKIE_NAME}=`;
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * A hostile stand-in for the deployed dashboard's API surface — hostile meaning it does not trust
 * `deploy-smoke.ts` to have attached the cookie correctly, the way the real deployment's own gate
 * (`apiHandlers.ts`'s one check, before any route is matched) does not either. Every gated route
 * demands proof (a real `herald_session` cookie) on every request; the two routes that are not
 * gated — `GET /` and `POST /api/login` — behave the way the real deployment's do, so the "before
 * logging in" checks (`checkAnonymous`) still see the responses they expect.
 *
 * Accepts any non-empty username/password on login, the same latitude the round-0 stub used — this
 * file is proving deploy-smoke's session *plumbing*, not testing a real credential store.
 */
async function startHostileStub(): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const selfOrigin = `http://${req.headers.host}`;

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>hostile stub SPA</body></html>");
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        if (!hasSession(req)) return send(res, 401, { error: "unauthorized" });
        return send(res, 200, {
          storageMode: "cloud",
          dbEnv: "production",
          sendsEnabled: false,
          conversionEnabled: false,
          availableTargets: ["google", "lark"],
          integrations: [
            { key: "google_drive", label: "Google Drive", configured: true },
            { key: "lark_drive", label: "Lark Drive", configured: true },
            { key: "telegram", label: "Telegram", configured: true },
            { key: "typefully", label: "Typefully", configured: true },
            { key: "google_sheets", label: "Google Sheets", configured: true },
          ],
        });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        if (req.headers.origin !== selfOrigin) return send(res, 403, { error: "forbidden origin" });
        let parsed: { username?: unknown; password?: unknown } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // fall through with {} — an unparsable body cannot supply credentials
        }
        if (!parsed.username || !parsed.password) return send(res, 401, { error: "invalid credentials" });
        const token = randomBytes(8).toString("hex");
        return send(
          res,
          200,
          { ok: true },
          { "set-cookie": `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=3600; Path=/` },
        );
      }

      if (req.method === "GET" && url.pathname === "/api/diagnostics/live") {
        if (!hasSession(req)) return send(res, 401, { error: "unauthorized" });
        const keys = [
          "google_auth",
          "google_drive_review",
          "google_drive_approved",
          "lark",
          "typefully",
          "telegram",
          "google_sheets",
        ];
        return send(res, 200, { probes: keys.map((key) => ({ key, status: "ok", detail: "hostile stub: alive" })) });
      }

      if (req.method === "POST" && url.pathname === "/api/items/deploy-smoke-probe/convert-prepare") {
        // The real deployment gates this route too, before answering 404 for "route genuinely
        // absent" — this stub demands the same proof for the same "prove it, don't trust the caller"
        // reason every other gated route here does.
        if (!hasSession(req)) return send(res, 401, { error: "unauthorized" });
        return send(res, 404, { error: "not found" });
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        if (!hasSession(req)) return send(res, 401, { error: "unauthorized" });
        return send(res, 200, { ok: true }, {
          "set-cookie": `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
        });
      }

      return send(res, 404, { error: "not found" });
    });
  });

  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * Runs the real `deploy-smoke.ts` (via `tsx`, the same binary `pnpm deploy:smoke` resolves to) as a
 * subprocess against `origin`, with `HERALD_SMOKE_USERNAME`/`HERALD_SMOKE_PASSWORD` set so it never
 * touches stdin — see `smokeCredentials.ts` for why a half- or un-configured pair would otherwise
 * fall through to an interactive prompt that would hang this test waiting on a TTY that is not there.
 * Resolves with the captured stdout (the formatted report) and exit code once the process exits.
 *
 * The watchdog `setTimeout` below is not what a correct run relies on — against a local stub this
 * exits in well under a second — it exists so a future regression that made `deploy-smoke.ts` hang,
 * rather than fail, kills its own subprocess instead of hanging this test (and, by extension,
 * `pnpm test`) indefinitely.
 */
function runDeploySmoke(origin: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [DEPLOY_SMOKE_ENTRY, origin], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HERALD_SMOKE_USERNAME: "probe-user",
        HERALD_SMOKE_PASSWORD: "probe-pass",
      },
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.resume(); // drain, unused — a failing check reports through stdout's own table

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("deploy-smoke.ts subprocess did not exit within 15s — killed to avoid hanging the suite"));
    }, 15000);

    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve({ stdout, exitCode: code ?? -1 });
    });
  });
}

describe("deploy:smoke's session against a real, hostile server", () => {
  it("logs in and completes every authenticated check with no failures", async () => {
    const origin = await startHostileStub();
    const { stdout, exitCode } = await runDeploySmoke(origin);

    // A guard on the guard: an empty or truncated report would vacuously contain no failure marker.
    expect(stdout.length, "deploy-smoke.ts produced no output at all").toBeGreaterThan(0);

    // `formatReport` (`src/doctor/report.ts`) always ends with a summary line of exactly this shape;
    // asserting on it directly is sturdier than scanning for the per-line "✗" glyph, and reads the
    // same claim the CLI itself prints. A bypassed authenticated call reaches this hostile stub with
    // no cookie, gets a real 401, and turns into a real `fail` here — `checkStatus`, `checkLiveness`,
    // `checkConvertPrepare`, and `checkLogout` (`smokeChecks.ts`) all grade an unexpected 401 as
    // `fail`, never `ok` or `warn`.
    expect(stdout, `expected a clean report (0 fail), got:\n${stdout}`).toMatch(/\d+ ok · \d+ warn · 0 fail/);

    // `deploy-smoke.ts` sets `process.exitCode = 1` the moment any check fails — this is the same
    // claim as the summary line, from the process's own exit status rather than its printed text.
    expect(exitCode, `deploy-smoke.ts exited non-zero against a fully-healthy hostile stub:\n${stdout}`).toBe(0);
  }, 20000);
});
