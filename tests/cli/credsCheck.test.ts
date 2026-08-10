// tests/cli/credsCheck.test.ts
//
// Runs the real `src/cli/creds-check.ts` against a stub deployment on localhost — the convention
// `tests/deploy/` uses for deploy scripts: execute the real thing, never a stand-in for it.
//
// Three things about how this file is built are load-bearing, and each replaced something the plan
// proposed that does not work here.
//
// **1. `spawn`, not `spawnSync`.** The stub server lives in this process, and `spawnSync` blocks this
// process's event loop until the child exits. The child's connection is accepted by the kernel but
// nothing ever answers it, so the child waits for a response that cannot arrive until it has already
// exited. Measured, not assumed: a `spawnSync` against an in-process `http` server returns
// `ETIMEDOUT` with empty stdout after exactly its timeout. Every test here would have burned its
// timeout and failed. `tests/deploy/smokeSessionRuntime.test.ts` already spawns asynchronously
// against an in-process stub for the same reason; this file follows it.
//
// **2. The child gets a hand-built environment, and is launched through `tsx` directly.**
// `pnpm -s creds:check` runs `tsx --env-file-if-exists=.env …`, and this machine's real `.env`
// defines `HERALD_SMOKE_USERNAME`, `HERALD_SMOKE_PASSWORD` and `HERALD_DEPLOYMENT_ORIGIN`. Node's
// `--env-file` precedence was measured rather than recalled (node v24.19.0): a variable already
// present in the child's environment WINS over the file, but a variable absent from the environment
// and present in the file IS applied. So a test that "unsets" `HERALD_SMOKE_*` by deleting it from
// the spawned environment would have had it handed straight back by `.env` — the last test below
// would have exercised a successful login rather than the refusal it claims to test. The same leak
// is worse for `HERALD_DEPLOYMENT_ORIGIN`: a test that meant to pass no origin would have inherited
// the real production one and sent real credentials at it from `pnpm test`.
// Spawning `tsx <entry>` with an environment built from nothing but `PATH` closes both holes — no
// env file is loaded and no ambient variable is inherited. The wiring that is therefore no longer
// covered by execution (that `pnpm creds:check` really is that command, env file included) is
// asserted directly against `package.json` in the last test.
//
// **3. The stub is hostile.** Every route but `POST /api/login` demands a real `herald_session`
// cookie and answers 401 without one — the same discipline `smokeSessionRuntime.test.ts` landed on,
// and the reason this file needs no source-text guard of its own. `creds-check.ts` makes exactly two
// authenticated calls and both are covered by execution here: a session-less
// `/api/diagnostics/live` 401s, `probes` comes back `undefined`, and `checkLiveness` fails the run —
// caught by "exits 0 when every probe is alive". A session-less `/api/status` is subtler, because
// its only output is `sendsEnabled`, and losing it merely defaults to `false`, which is invisible in
// an all-healthy report; "fails a dead send credential once the deployment reports sends open" is
// the test that makes it visible, and it is here for that reason and no other. Between them, both
// authenticated calls in the file are proven to carry a session at runtime, under any spelling.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { REPO_ROOT } from "../../src/paths";

const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(REPO_ROOT, "src", "cli", "creds-check.ts");

// Duplicated from `src/adapters/web/sessionCookie.ts` rather than imported, same as
// `smokeSessionRuntime.test.ts`: this stub stands in for an independent deployment that shares no
// code — and no trust — with the process under test.
const SESSION_COOKIE_NAME = "herald_session";

/** What the stub answers with. Each test sets what it cares about; `beforeEach` restores the rest. */
interface StubState {
  probes: unknown;
  liveStatus: number;
  sendsEnabled: boolean;
  /** When false, `POST /api/login` answers 200 with no `Set-Cookie` — a 200 that yields no session. */
  loginSetsCookie: boolean;
  /** `GET /api/status`'s status code for a request that DOES carry a session. */
  statusStatus: number;
  /** `GET /api/status`'s raw body; `undefined` means the normal `{"sendsEnabled": …}` JSON. */
  statusRawBody?: string;
}

const HEALTHY: StubState = {
  probes: [],
  liveStatus: 200,
  sendsEnabled: false,
  loginSetsCookie: true,
  statusStatus: 200,
  statusRawBody: undefined,
};
let stub: StubState = { ...HEALTHY };
let server: Server;
let origin = "";

function hasSession(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? "").split(";").some((part) => {
    const t = part.trim();
    return t.startsWith(`${SESSION_COOKIE_NAME}=`) && t !== `${SESSION_COOKIE_NAME}=`;
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/login") {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (stub.loginSetsCookie) headers["set-cookie"] = `${SESSION_COOKIE_NAME}=stub; Path=/`;
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!hasSession(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    if (url === "/api/status") {
      res.writeHead(stub.statusStatus, { "content-type": "application/json" });
      res.end(stub.statusRawBody ?? JSON.stringify({ sendsEnabled: stub.sendsEnabled }));
      return;
    }
    if (url === "/api/diagnostics/live") {
      res.writeHead(stub.liveStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ probes: stub.probes }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  stub = { ...HEALTHY };
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the watchdog had to kill it — the process did not decide anything on its own. */
  timedOut: boolean;
}

/**
 * The real CLI, as a subprocess. `env` entries set to `undefined` are absent from the child's
 * environment rather than set to the string "undefined"; nothing else is inherited (see the header).
 *
 * The child's stdin is a pipe this function never writes to and never closes, on purpose: if a
 * future edit reintroduced an interactive prompt, it would block on a stdin that never answers —
 * which is exactly what happens under a systemd timer, and exactly what the last test asserts must
 * not happen. Closing stdin instead would hand a prompt an immediate EOF and hide the regression.
 */
function run(env: Record<string, string | undefined> = {}, args: string[] = [origin], timeoutMs = 15_000): Promise<Run> {
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    HERALD_SMOKE_USERNAME: "probe",
    HERALD_SMOKE_PASSWORD: "probe-password",
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) childEnv[key] = value;

  return new Promise<Run>((resolve, reject) => {
    const child = spawn(TSX_BIN, [ENTRY, ...args], { cwd: REPO_ROOT, env: childEnv });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

const ALL_OK = [
  { key: "google_auth", status: "ok", detail: "token refreshed" },
  { key: "google_drive_review", status: "ok", detail: "reachable" },
  { key: "google_drive_approved", status: "ok", detail: "reachable" },
  { key: "google_sheets", status: "ok", detail: "reachable" },
  { key: "lark", status: "ok", detail: "tenant token issued" },
  { key: "typefully", status: "ok", detail: "social set reachable" },
  { key: "telegram", status: "ok", detail: "bot token valid" },
];

const dead = (key: string) => ALL_OK.map((p) => (p.key === key ? { ...p, status: "dead", detail: "HTTP 401" } : p));

describe("pnpm creds:check", () => {
  it("exits 0 when every probe is alive", async () => {
    stub.probes = ALL_OK;
    const r = await run();
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("live: google_auth");
    expect(r.stdout).toMatch(/\d+ ok · \d+ warn · 0 fail/);
  });

  it("exits 1 when a publishing credential is dead", async () => {
    stub.probes = dead("google_auth");
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("google_auth");
  });

  it("does not fail on a dead send credential while sends are closed", async () => {
    // The stub reports sendsEnabled: false, so this is a warn — matching checkLiveness's own rule.
    stub.probes = dead("telegram");
    stub.sendsEnabled = false;
    const r = await run();
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  });

  it("fails a dead send credential once the deployment reports sends open", async () => {
    // The other half of the rule — and the only test that can tell whether `/api/status` was read
    // with a session at all. `sendsEnabled` is the sole thing that call contributes, and a 401 there
    // is indistinguishable from `sendsEnabled: false` in every other test in this file. See header.
    stub.probes = dead("telegram");
    stub.sendsEnabled = true;
    const r = await run();
    expect(r.exitCode, `a dead send credential with sends open must fail:\n${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toContain("live: telegram");
  });

  /**
   * The three ways `/api/status` can fail to answer the one question this command asks it — and all
   * three used to exit 0 with `6 ok · 1 warn · 0 fail` while a send credential was dead.
   *
   * The mechanism is worth stating because it is silent by construction: an unreadable `/api/status`
   * yields no `sendsEnabled`, that collapses to `false`, and `false` is precisely "sends are closed,
   * so a dead send credential is only a warn". The lenient verdict is the DEFAULT for a route that
   * could not be read, so the one case where the answer matters most — sends actually open in
   * production — is the case the failure hides. Not knowing is not the same as being fine.
   *
   * Each variant therefore pins `telegram` dead: the probe whose severity depends on the answer.
   */
  describe.each([
    {
      what: "cannot be read at all",
      arrange: () => {
        stub.statusStatus = 401;
      },
      says: "HTTP 401",
    },
    {
      what: "answers with a body that is not JSON",
      arrange: () => {
        stub.statusRawBody = "<html>bad gateway</html>";
      },
      says: "did not parse",
    },
    {
      what: "answers JSON with no sendsEnabled flag",
      arrange: () => {
        stub.statusRawBody = "{}";
      },
      says: "no boolean `sendsEnabled`",
    },
  ])("when /api/status $what", ({ arrange, says }) => {
    it("fails, and says the send tier could not be graded", async () => {
      stub.probes = dead("telegram");
      arrange();
      const r = await run();
      expect(r.exitCode, `an unreadable /api/status must not read as a pass:\n${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout).toContain("sendsEnabled");
      expect(r.stdout).toContain(says);
      // The point of the fail: the operator is told the send tier's severity is ungraded, rather
      // than being handed the lenient half of a judgement nobody made.
      expect(r.stdout).toContain("could not be graded");
    });
  });

  it("exits 1 when the route cannot be read", async () => {
    stub.probes = [];
    stub.liveStatus = 500;
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("could not be read");
  });

  it("takes the origin from HERALD_DEPLOYMENT_ORIGIN when no argument is given", async () => {
    stub.probes = ALL_OK;
    const r = await run({ HERALD_DEPLOYMENT_ORIGIN: origin }, []);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  });

  it("exits 2 when no origin is given at all", async () => {
    const r = await run({}, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });

  // `new URL()` accepting a string is not the same as that string addressing a deployment.
  // `mailto:` and `file:` both parse, and both have an `origin` of the *string* `"null"` — so the
  // parse guard passes them through, the client is built on `"null"`, and `fetch("null/api/login")`
  // fails as a network error. The operator's report then says the deployment was unreachable and the
  // exit code says a credential check failed, when what actually happened is that this machine is
  // configured with something that is not a deployment URL. That is a 2, not a 1: the exit codes are
  // a contract for the systemd unit, and 1 must mean "go look at a credential".
  it.each(["mailto:ops@example.com", "file:///etc/hosts", "ftp://example.com/x"])(
    "exits 2 on %s, a URL that parses but cannot address a deployment",
    async (url) => {
      const r = await run({}, [url]);
      expect(r.exitCode, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain(url);
      expect(r.stdout, "a configuration error must not print a credential report").toBe("");
    },
  );

  it("reports a login that returns 200 with no session as a failed check, not a stack trace", async () => {
    // `createDeploymentClient.authed()` THROWS when there is no session, and a 200 carrying no
    // `Set-Cookie` reaches exactly that state while `logIn()` still reports 200. Unguarded, the
    // throw leaves as an unhandled rejection: under the timer the operator gets a Telegram alert
    // plus a Node error line that names an internal invariant, which is the same disease this
    // feature treats — a failure that does not say what failed. It must come out as an ordinary
    // fail line in the report, with exit 1.
    stub.probes = ALL_OK;
    stub.loginSetsCookie = false;
    const r = await run();
    expect(r.exitCode, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/\d+ ok · \d+ warn · [1-9]\d* fail/);
    expect(r.stdout.toLowerCase()).toContain("session");
    expect(r.stderr, "an internal invariant leaked to the operator instead of a report line").not.toContain(
      "programming error",
    );
  });

  // The one a hang would otherwise hide.
  it("refuses immediately when HERALD_SMOKE_* is unset, instead of blocking on a prompt", async () => {
    stub.probes = ALL_OK;
    const r = await run({ HERALD_SMOKE_USERNAME: undefined, HERALD_SMOKE_PASSWORD: undefined }, [origin], 10_000);
    expect(r.timedOut, "the process must return, not hang until the watchdog kills it").toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("HERALD_SMOKE_USERNAME");
  });

  it("is wired into package.json as the command the timer will run", async () => {
    // Execution above deliberately bypasses `pnpm` and the env file to stay hermetic (see header),
    // so the wiring itself is asserted here instead of being left uncovered.
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["creds:check"]).toBe("tsx --env-file-if-exists=.env src/cli/creds-check.ts");
  });
});
