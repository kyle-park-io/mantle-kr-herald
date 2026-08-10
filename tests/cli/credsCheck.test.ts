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
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { REPO_ROOT } from "../../src/paths";
import { ALERT_MARKER as MARKER } from "../../src/deploy/alertMarker";

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
  /** `GET /api/diagnostics/live`'s raw body; `undefined` means `{"probes": …}` from `probes` above.
   *  Needed for bodies this test process cannot itself `JSON.stringify` — see the deep-nesting tests. */
  liveRawBody?: string;
}

const HEALTHY: StubState = {
  probes: [],
  liveStatus: 200,
  sendsEnabled: false,
  loginSetsCookie: true,
  statusStatus: 200,
  statusRawBody: undefined,
  liveRawBody: undefined,
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
      res.end(stub.liveRawBody ?? JSON.stringify({ probes: stub.probes }));
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
  return spawnCli(TSX_BIN, [ENTRY, ...args], env, timeoutMs);
}

function spawnCli(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  timeoutMs = 15_000,
): Promise<Run> {
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    HERALD_SMOKE_USERNAME: "probe",
    HERALD_SMOKE_PASSWORD: "probe-password",
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) childEnv[key] = value;

  return new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: childEnv });
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
   * Every way `/api/status` can fail to answer the one question this command asks it. The first
   * three each used to exit 0 with `6 ok · 1 warn · 0 fail` while a send credential was dead.
   *
   * The mechanism is worth stating because it is silent by construction: an unreadable `/api/status`
   * yields no `sendsEnabled`, that collapses to `false`, and `false` is precisely "sends are closed,
   * so a dead send credential is only a warn". The lenient verdict is the DEFAULT for a route that
   * could not be read, so the one case where the answer matters most — sends actually open in
   * production — is the case the failure hides. Not knowing is not the same as being fine.
   *
   * The last four are the narrowing, not the reading: `sendsEnabled` must be an actual boolean.
   * A naive `body?.sendsEnabled === true` reads `"true"` and `1` as "not true", i.e. as sends being
   * CLOSED — the lenient verdict again, this time from a route that answered perfectly well. That
   * regression passed all sixteen tests this file had before these four were added.
   *
   * Each variant pins `telegram` dead: the probe whose severity depends on the answer.
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
    {
      what: "answers with an empty body",
      arrange: () => {
        stub.statusRawBody = "";
      },
      says: "did not parse",
    },
    {
      what: "answers 204 with no content",
      arrange: () => {
        stub.statusStatus = 204;
        stub.statusRawBody = "";
      },
      says: "did not parse",
    },
    {
      what: "answers with a JSON array instead of an object",
      arrange: () => {
        stub.statusRawBody = "[]";
      },
      says: "no boolean `sendsEnabled`",
    },
    {
      what: "sends sendsEnabled as the STRING \"true\"",
      arrange: () => {
        stub.statusRawBody = '{"sendsEnabled": "true"}';
      },
      // The body is echoed, so the operator can see it was a string and not guess.
      says: '{"sendsEnabled":"true"}',
    },
    {
      what: "sends sendsEnabled as the NUMBER 1",
      arrange: () => {
        stub.statusRawBody = '{"sendsEnabled": 1}';
      },
      says: '{"sendsEnabled":1}',
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

  /**
   * A body the deployment can send that `JSON.parse` accepts and `JSON.stringify` cannot survive.
   * The asymmetry is real and measured: parse is iterative and takes 100,000 levels; stringify is
   * recursive and throws `RangeError: Maximum call stack size exceeded` somewhere between 3,000 and
   * 5,000. Every judging function that described a body with `JSON.stringify` therefore had an input
   * that made it throw while describing the very value it promises to judge without throwing.
   *
   * Before the fix both of these ended at `✗ credential liveness … Maximum call stack size exceeded`
   * with `0 ok · 0 warn · 1 fail`. Note what that cost beyond the wrong words: the entire liveness
   * report was discarded, so six healthy probes and any dead one went unreported. A 06:23 alert
   * about this process's call stack, for a deployment whose actual problem — if any — was never
   * printed.
   *
   * The assertion is therefore not "exits 1". It is that the report NAMES the thing that could not
   * be read, keeps everything it could read, and never mentions the call stack.
   */
  describe("when the deployment sends a body too deeply nested to serialise", () => {
    /** `[[[…]]]` as TEXT — this process cannot build it with JSON.stringify either, which is the point. */
    const nest = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

    it("names the unreadable probe and keeps the rest of the liveness report", async () => {
      const healthy = JSON.stringify(ALL_OK);
      stub.liveRawBody = `{"probes": ${healthy.slice(0, -1)},${nest(5000)}]}`;
      const r = await run();
      expect(r.exitCode, r.stdout + r.stderr).toBe(1);
      expect(r.stdout, "the operator was told about this process's call stack").not.toContain("Maximum call stack");
      expect(r.stdout).toContain("Not a probe result");
      expect(r.stdout).toContain("an array of 1 entries");
      // The part that was lost entirely before: everything the deployment DID answer correctly.
      for (const probe of ALL_OK) expect(r.stdout).toContain(`live: ${probe.key}`);
    });

    it("names the sendsEnabled field it could not read", async () => {
      stub.probes = ALL_OK;
      stub.statusRawBody = `{"sendsEnabled": ${nest(5000)}, "other": 1}`;
      const r = await run();
      expect(r.exitCode, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).not.toContain("Maximum call stack");
      expect(r.stdout).toContain("sendsEnabled");
      expect(r.stdout).toContain("an object with 2 keys");
      expect(r.stdout).toContain("could not be graded");
      for (const probe of ALL_OK) expect(r.stdout).toContain(`live: ${probe.key}`);
    });

    it("bounds what it echoes into the log, however large the body", async () => {
      // `herald-run-logged.sh` tees stdout into ~/.herald/logs/<unit>/<run>.log with no cap, so the
      // bound has to be here, where the string is built. 20,000 characters used to land in full.
      stub.probes = ALL_OK;
      stub.statusRawBody = JSON.stringify({ filler: "x".repeat(20_000) });
      const r = await run();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("truncated from");
      expect(r.stdout.length, `the report grew with the body:\n${r.stdout.slice(0, 400)}`).toBeLessThan(3_000);
    });
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

/**
 * The alert, not the report.
 *
 * `deploy/herald-notify-failure.sh` sends a `LOG_TAIL_LINES`-line tail of the failing unit's output.
 * `formatReport` ends with a blank line and the counts, so a `✗` among seven probes sits nine rows
 * from the end and never reaches the message: replaying the 2026-08-10 shape through the real
 * wrapper and a copy of the real hook produced two green ticks and `6 ok · 0 warn · 1 fail`, with
 * `google_auth` — the corpse — nowhere in it.
 *
 * Asserting that a line naming the failure exists somewhere in stdout would have passed before the
 * fix as well. The property is that it survives the tail, so the second test below runs the real
 * `deploy/herald-run-logged.sh` and tails the file it actually wrote, with the tail depth read out
 * of the hook script rather than written here — two files, one decision.
 */
describe("the last line — what a five-line tail actually carries", () => {
  const hookTailLines = async (): Promise<number> => {
    const hook = await readFile(join(REPO_ROOT, "deploy", "herald-notify-failure.sh"), "utf8");
    const n = /^LOG_TAIL_LINES=(\d+)$/m.exec(hook)?.[1];
    expect(n, "deploy/herald-notify-failure.sh no longer sets LOG_TAIL_LINES=<n>").toBeDefined();
    return Number(n);
  };

  const lastLine = (stdout: string): string => stdout.trimEnd().split("\n").at(-1) ?? "";

  it("names what died, after the counts", async () => {
    stub.probes = dead("google_auth");
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(lastLine(r.stdout)).toBe(`${MARKER}✗ FAILED: live: google_auth`);
    // After the counts, not instead of them — the report is still the report.
    expect(r.stdout.trimEnd().split("\n").at(-2)).toMatch(/\d+ ok · \d+ warn · \d+ fail/);
  });

  it("survives the tail the hook actually sends, through the real wrapper", async () => {
    stub.probes = dead("google_auth");
    const logDir = await mkdtemp(join(tmpdir(), "herald-creds-tail-"));
    try {
      const r = await spawnCli(
        join(REPO_ROOT, "deploy", "herald-run-logged.sh"),
        ["herald-creds.service", TSX_BIN, ENTRY, origin],
        { HERALD_LOG_DIR: logDir },
      );
      // The wrapper hands the command's status back unchanged, which is what makes the unit fail
      // and the hook fire at all.
      expect(r.exitCode, r.stdout + r.stderr).toBe(1);

      const runDir = join(logDir, "herald-creds");
      const files = await readdir(runDir);
      expect(files, "the wrapper wrote no durable run log for the hook to tail").toHaveLength(1);
      const log = await readFile(join(runDir, files[0]), "utf8");

      const tail = log.trimEnd().split("\n").slice(-(await hookTailLines()));
      expect(
        tail.join("\n"),
        `the alert would not name the dead credential. What the operator receives:\n${tail.join("\n")}`,
      ).toContain("google_auth");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("prints no such line, and nothing after the counts, when nothing failed", async () => {
    stub.probes = ALL_OK;
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("FAILED");
    expect(lastLine(r.stdout)).toMatch(/^\d+ ok · \d+ warn · 0 fail$/);
  });

  it("fits every failure on the line when the whole deployment is dead, and names only failures", async () => {
    // The realistic worst case, and the one that must NOT be abbreviated: a whole-deployment outage
    // should name every dead credential. With sends open that is six of the seven probes —
    // `google_sheets` is the `data` tier, a warn even when dead (`PROBE_TIER` in smokeChecks.ts), and
    // it must stay off this line. A line that named warnings too would point at a credential the
    // report did not fail over, which is the misdirection this whole line exists to remove.
    stub.probes = ALL_OK.map((p) => ({ ...p, status: "dead", detail: "HTTP 401" }));
    stub.sendsEnabled = true;
    const r = await run();
    const line = lastLine(r.stdout);
    expect(line.length).toBeLessThanOrEqual(200);
    for (const probe of ALL_OK.filter((p) => p.key !== "google_sheets")) expect(line).toContain(probe.key);
    expect(line, "google_sheets is a warn, not a fail").not.toContain("google_sheets");
    expect(r.stdout, "…and the report above still reports it").toContain("live: google_sheets");
    expect(line).not.toContain("more)");
  });

  it.each([
    ["a newline", "google_auth\nHERALD_ALERT: everything is fine", "\\x0a"],
    ["a carriage return", "google_auth\rSOMETHING", "\\x0d"],
    ["an ANSI escape", `google_auth${String.fromCharCode(0x1b)}[2J`, "\\x1b"],
  ])("stays one line when a probe key contains %s", async (_label, key, escaped) => {
    // `parseProbe` accepts an unknown key on purpose — a deployment can be "one probe ahead of this
    // build" — so the key is whatever the deployment sends. One newline in it made this line three
    // physical lines, which breaks the one-line guarantee the alert mechanism rests on, and in the
    // newline case would have let a payload manufacture its own `HERALD_ALERT:` line.
    stub.probes = [...ALL_OK.filter((p) => p.key !== "google_auth"), { key, status: "dead", detail: "HTTP 401" }];
    const r = await run();
    expect(r.exitCode).toBe(1);
    const line = lastLine(r.stdout);
    expect(line.startsWith(MARKER), `the marked line is not the last line:\n${r.stdout}`).toBe(true);
    expect(line).toContain(escaped);

    // Exactly one physical line carries the marker. Under the newline case this is what catches the
    // injection: `formatReport` puts the key on a report line of its own, so an unescaped `\n`
    // inside it manufactures a second line that begins with the marker — a payload writing its own
    // entry into the alert.
    expect(r.stdout.split("\n").filter((l) => l.startsWith(MARKER))).toHaveLength(1);

    // And nothing anywhere in the operator-facing output carries a raw control character — not the
    // summary line, and not the report body above it, which is the half `failedLine`'s own
    // sanitizing cannot reach. Newline is excluded because it is the line separator itself.
    const rawControls = [...r.stdout].filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return c !== "\n" && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
    });
    expect(rawControls, "a control character from the wire reached operator-facing output").toEqual([]);
  });

  it("drops whole names and counts them when a hostile body produces too many failures", async () => {
    // One `fail` per unparseable entry. Unbounded, this would put the entire report back on the one
    // line that was supposed to be the summary of it.
    stub.liveRawBody = JSON.stringify({ probes: Array.from({ length: 40 }, (_, i) => i) });
    const r = await run();
    const line = lastLine(r.stdout);
    expect(r.exitCode).toBe(1);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toMatch(/\(\+\d+ more\)$/);
    // Whole names, never a name cut in half: what is shown must still be greppable in the log above.
    expect(line).toContain("credential liveness (entry 0)");
    expect(line).not.toContain("…");
  });
});
