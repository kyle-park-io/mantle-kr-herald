// tests/deploy/notifyFailure.test.ts
//
// Exercises the real deploy/herald-notify-failure.sh end to end — never the real .env, never a
// real Telegram call, never the real journal. A throwaway copy of the script has its hardcoded
// REPO_DIR repointed at a synthetic repo (its own throwaway .env), and stub `curl`/`journalctl`
// executables are put ahead of everything else on PATH, so the script's own env-var reading,
// journal-excerpt capture, truncation and JSON payload building all run for real while every real
// side effect (an HTTP call, a real journal read) is captured instead of performed.
//
// The script now takes the failing unit's name as $1 (systemd's %i, via the templated
// deploy/herald-notify-failure@.service) instead of hardcoding herald-watch.service — see that
// file's own header and herald-notify-failure.sh's header for why. TEST_UNIT below is deliberately
// NOT herald-watch.service, the one name the script used to hardcode: using a different name here
// is what actually proves the argument is read and used, rather than a leftover hardcode a test
// using the old name would never catch.
//
// This is the automated form of the manual verification recorded in task-5-report.md (a
// REPO_DIR-repointed copy against a synthetic .env, diffed against Node's own --env-file parsing)
// — kept here so a regression is caught by `pnpm test`, not only by re-reading a report.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../src/paths";

const TEST_UNIT = "herald-x-reconcile.service";
const REAL_SCRIPT_PATH = join(REPO_ROOT, "deploy", "herald-notify-failure.sh");
// Since 2026-08-07 the script derives REPO_DIR from its own location rather than hardcoding a
// development path, because it is now invoked out of the deploy checkout (%h/.herald/app) — see
// tests/deploy/workingDirectory.test.ts. The repoint below still has to override it, because the
// throwaway copy this test writes lives in a temp directory whose parent is not a checkout at all.
const REAL_REPO_DIR_LINE = 'REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"';

let workDir: string;
let repoDir: string;
let stubDir: string;
let scriptPath: string;
/**
 * Stands in for ~/.herald/logs — the durable run logs deploy/herald-run-logged.sh writes, which the
 * script now reads FIRST, falling back to the journal only when there is no run log (or an empty
 * one) for the unit. Always pointed at a temp directory, never left to the default: without the
 * override every test would either read Kyle's real production run logs or (worse) never exercise
 * the journal fallback at all, since a real box always has one. Never `mkdir`'d ahead of time in
 * `beforeEach` — a test that wants the journal branch simply does not call `seedRunLog`, and the
 * absent directory makes `ls` on it fail exactly like an empty one would.
 */
let logRoot: string;

/** curl stub: APPENDS the JSON body (the argument immediately after `-d`) to curl-body.log — one
 *  send can now become two, HTML then a plain-text retry, since deploy/herald-notify-failure.sh
 *  retries once when Telegram rejects the HTML — and exits with an exit code the test chooses,
 *  letting tests simulate Telegram accepting or rejecting the request without a real network call.
 *
 *  Two ways to choose that code, because `STUB_CURL_EXIT` alone could only ever say "every attempt
 *  fails identically":
 *    - `STUB_CURL_EXIT` — one code for every invocation (default 0).
 *    - `STUB_CURL_EXITS` — space-separated, one per invocation in order ("22 0" = reject the HTML
 *      attempt, accept the plain-text retry), falling back to STUB_CURL_EXIT once it runs out.
 *  Without the per-invocation form the suite could prove the retry is ATTEMPTED but never that it
 *  LANDS, which is the entire reason the retry exists: the whole point is a message that arrives
 *  unformatted instead of not arriving. The invocation count lives in `curl-calls` rather than in
 *  the environment because each invocation is a separate process.
 *
 *  Each body is followed by a `\n ` record separator (a real newline, then a space) rather than
 *  overwriting the file on every invocation. That separator is itself insignificant JSON
 *  whitespace, so a single-body file still parses with a bare `JSON.parse(readFileSync(...))` —
 *  existing tests that do exactly that are unaffected — and it cannot appear inside a body: the
 *  payload is always one physical line, since json_escape turns an embedded newline into the
 *  two-character `\n` escape, never a raw newline byte. */
const CURL_STUB_LINES = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'BODY_LOG="$STUB_DIR/curl-body.log"',
  ': > "$STUB_DIR/curl-invoked"',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "-d" ]; then',
  '    printf "%s\\n " "$arg" >> "$BODY_LOG"',
  "  fi",
  '  prev="$arg"',
  "done",
  'calls=$(( $(cat "$STUB_DIR/curl-calls" 2>/dev/null || echo 0) + 1 ))',
  'printf %s "$calls" > "$STUB_DIR/curl-calls"',
  'if [ -n "${STUB_CURL_EXITS:-}" ]; then',
  '  read -r -a codes <<< "$STUB_CURL_EXITS"',
  '  if [ "$calls" -le "${#codes[@]}" ]; then exit "${codes[$((calls - 1))]}"; fi',
  "fi",
  'exit "${STUB_CURL_EXIT:-0}"',
];

/**
 * The systemd invocation id every fixture in this file shares: the one `seedRunLog` writes into the
 * run log's header line, and the one the systemctl stub reports as the unit's current one. Equal by
 * default, because "the run log belongs to this run" is the ordinary case; a test that wants the
 * stale-log case makes them differ on purpose.
 */
const TEST_INVOCATION_ID = "1f2e3d4c5b6a79880123456789abcdef";

/**
 * systemctl stub, and the reason this file has one at all.
 *
 * The script asks systemd two things: whether a run log on disk belongs to the run that just failed
 * (`InvocationID`), and what that run's exit code was (`ExecMainCode`/`ExecMainStatus`). Until
 * 2026-08-10 this test's env whitelist carried no D-Bus address, so `systemctl --user` could not
 * reach the user manager, every lookup failed, and the header assertions passed *because the branch
 * never ran*. That is not a harmless gap: on a real box the same call SUCCEEDS and returns `0` for a
 * unit systemd cannot account for, which is how `⚠ <unit> 실패 (exit 0)` — a header contradicting
 * itself — reached production while this suite was green. Same shape as the `journalctl` stub that
 * ignored `-n` (see below): a mechanism sound by luck of the harness rather than by the test.
 *
 * A stub rather than the real thing, because the real thing is not deterministic here: TEST_UNIT
 * and the marker file's `herald-creds.service` are BOTH installed on the development box, so a real
 * lookup would splice whatever those units last did on this machine into the assertions (measured:
 * `herald-creds.service` reports ExecMainStatus=2 right now) and would answer differently again on
 * CI, which has no user manager at all.
 *
 * Each property is driven independently, and the defaults are chosen so the ordinary case needs no
 * configuration: an invocation id matching what `seedRunLog` writes (so a seeded run log is usable),
 * and `ExecMainCode=0`/`ExecMainStatus=0` — verbatim what a real `systemctl --user show` prints for
 * a unit it has never heard of, measured on a live box. It never returns empty.
 *
 * Prints ExecMainStatus BEFORE ExecMainCode, the reverse of the order the script asks for them in,
 * because that is what systemd does: it emits properties in its own order, not the requested one
 * (verified: `-p ActiveState -p SubState -p LoadState --value` prints LoadState first). Any reader
 * that parses two `--value` lines positionally therefore reads them swapped, and this stub is what
 * makes that a failing test rather than a live misreport.
 */
const SYSTEMCTL_STUB_LINES = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  // STUB_SYSTEMCTL_SILENT: no output and a non-zero exit — a box where systemctl exists but has no
  // user manager to ask (a container, CI, a session whose bus is gone).
  'if [ -n "${STUB_SYSTEMCTL_SILENT:-}" ]; then exit "${STUB_SYSTEMCTL_EXIT:-1}"; fi',
  // HONOURS `-p`, and emits nothing for a name it does not recognise — which is exactly what real
  // systemctl does (verified: `-p NoSuchPropertyXyz` produces no line and exit 0). A stub that
  // always printed all three would make a typo'd property name in the script invisible here while
  // silently costing the real thing its answer.
  "want_status=0; want_code=0; want_invocation=0",
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "-p" ]; then',
  '    case "$arg" in',
  "      ExecMainStatus) want_status=1 ;;",
  "      ExecMainCode) want_code=1 ;;",
  "      InvocationID) want_invocation=1 ;;",
  "    esac",
  "  fi",
  '  prev="$arg"',
  "done",
  // Emitted in a FIXED order that is deliberately not the order the script asks for them in,
  // because systemd emits properties in its own order too. Positional parsing has to fail here.
  '[ "$want_status" = 1 ] && printf "ExecMainStatus=%s\\n" "${STUB_EXEC_MAIN_STATUS:-0}"',
  '[ "$want_code" = 1 ] && printf "ExecMainCode=%s\\n" "${STUB_EXEC_MAIN_CODE:-0}"',
  // `-` not `:-`: an explicitly empty STUB_INVOCATION_ID means "systemd knows of no invocation for
  // this unit", which is what it reports for one it has never heard of, and is distinct from unset.
  `[ "$want_invocation" = 1 ] && printf "InvocationID=%s\\n" "\${STUB_INVOCATION_ID-${TEST_INVOCATION_ID}}"`,
  'exit "${STUB_SYSTEMCTL_EXIT:-0}"',
];

/**
 * journalctl stub: prints the last `-n N` lines of $STUB_JOURNAL_OUTPUT (may be unset/empty) and
 * exits $STUB_JOURNAL_EXIT (default 0).
 *
 * **It honours `-n`, and did not until 2026-08-10.** Ignoring it meant `LOG_TAIL_LINES=5` was never
 * exercised on the journal branch by any test in this repo: the script asked for five lines and the
 * stub handed back the whole fixture, so every assertion about what the tail does or does not carry
 * was really an assertion about a stub that returns everything. The marked-line mechanism's own
 * premise — that the line sits outside the window — was not what ran. Every fixture here is two
 * lines or fewer, so honouring it changes no expectation in this file; it changes what the file
 * proves.
 */
const JOURNALCTL_STUB_LINES = [
  "#!/usr/bin/env bash",
  'n=""; prev=""',
  'for arg in "$@"; do [ "$prev" = "-n" ] && n="$arg"; prev="$arg"; done',
  'out="${STUB_JOURNAL_OUTPUT:-}"',
  'if [ -n "$n" ] && [ -n "$out" ]; then out="$(printf %s "$out" | tail -n "$n")"; fi',
  'printf %s "$out"',
  'exit "${STUB_JOURNAL_EXIT:-0}"',
];

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  await chmod(path, 0o755);
}

/**
 * The header line deploy/herald-run-logged.sh writes before it runs anything, carrying the systemd
 * invocation id the hook verifies the file against. Spelled here rather than imported because the
 * wrapper is bash; the "the wrapper writes a header this hook accepts" test below runs the REAL
 * wrapper end to end, so a drift between the two files fails there rather than making every fixture
 * in this file quietly unverifiable.
 */
function wrapperHeader(unit: string, invocation: string = TEST_INVOCATION_ID, cmd = "pnpm the-command"): string {
  return `=== ${unit} started 2026-08-10T07:00:00Z invocation ${invocation} — ${cmd} ===`;
}

/**
 * Writes a durable run log for `unit` under the stand-in log root, named the way
 * deploy/herald-run-logged.sh names one — and, by default, HEADED the way the wrapper heads one.
 *
 * The header is not decoration: since the hook refuses any run log it cannot attribute to the run
 * that just failed, a fixture without one is a file the hook will not read at all. `invocation`
 * sets the id in that header (pass a different one to seed a PREVIOUS run's log); `invocation: null`
 * writes the body bare, which is an old log from before the wrapper recorded ids, and is therefore
 * unusable by design. `mtime` is settable so a test can invert the mtime order against the name
 * order — see the test that relies on it.
 */
async function seedRunLog(
  unit: string,
  stamp: string,
  body: string,
  opts: { mtime?: Date; invocation?: string | null } = {},
): Promise<string> {
  const dir = join(logRoot, unit.replace(/\.service$/, ""));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.log`);
  const invocation = opts.invocation === undefined ? TEST_INVOCATION_ID : opts.invocation;
  const contents = invocation === null ? body : `${wrapperHeader(unit, invocation)}\n${body}`;
  await writeFile(path, contents, "utf8");
  if (opts.mtime) await utimes(path, opts.mtime, opts.mtime);
  return path;
}

async function writeSyntheticEnv(vars: Record<string, string>): Promise<void> {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writeFile(join(repoDir, ".env"), body + "\n", "utf8");
}

/** The record separator the curl stub appends after each body — see CURL_STUB_LINES' own comment. */
const CURL_BODY_SEPARATOR = "\n ";

/** Every JSON body curl was invoked with, in call order (HTML attempt first, plain retry second
 *  when there is one). Empty if curl was never invoked at all. */
async function readAllCurlBodies(): Promise<string[]> {
  const raw = await readFile(join(stubDir, "curl-body.log"), "utf8");
  return raw.split(CURL_BODY_SEPARATOR).filter((s) => s.length > 0);
}

/** The first (and, absent a retry, only) body curl was invoked with. */
async function readCurlBody(): Promise<string> {
  return (await readAllCurlBodies())[0] ?? "";
}

/**
 * Runs the throwaway script copy with `unit` as $1 — omit it (or pass "") to exercise the refusal
 * path the script now takes instead of falling back to a hardcoded unit name.
 */
function runScript(
  unit: string | undefined,
  env: Record<string, string | undefined> = {},
): { status: number | null; stderr: string } {
  const args = unit === undefined ? [scriptPath] : [scriptPath, unit];
  const result = spawnSync("bash", args, {
    env: {
      PATH: `${stubDir}:/usr/bin:/bin`,
      STUB_DIR: stubDir,
      HOME: process.env.HOME, // journalctl/curl stubs don't need it, but bash itself may
      HERALD_LOG_DIR: logRoot,
      // The user bus, so `systemctl --user` is *able* to work here the way it does under systemd.
      // Its absence used to be what made the exit-code branch untested — see SYSTEMCTL_STUB_LINES.
      // The stub on PATH is what actually answers; these are here so that nothing in this file
      // passes because a bus was missing, and so removing the stub fails loudly instead of quietly
      // reverting to the accident. Left undefined on a box that has neither, e.g. CI.
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stderr: result.stderr };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "herald-notify-failure-test-"));
  repoDir = join(workDir, "repo");
  stubDir = join(workDir, "stubs");
  // Deliberately NOT created: an absent log root is the state on a box where no scheduled run has
  // happened yet, and every test that does not seed a run log exercises exactly that.
  logRoot = join(workDir, "logs");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });

  // A throwaway copy of the real script with REPO_DIR repointed at the synthetic repo above —
  // never the real one, and the real .env is never read or touched.
  const real = await readFile(REAL_SCRIPT_PATH, "utf8");
  expect(real, "REPO_DIR line moved — update this test's repoint logic to match").toContain(REAL_REPO_DIR_LINE);
  const repointed = real.replace(REAL_REPO_DIR_LINE, `REPO_DIR="${repoDir}"`);
  scriptPath = join(workDir, "herald-notify-failure.sh");
  await writeExecutable(scriptPath, repointed.split("\n"));

  await writeExecutable(join(stubDir, "curl"), CURL_STUB_LINES);
  await writeExecutable(join(stubDir, "journalctl"), JOURNALCTL_STUB_LINES);
  await writeExecutable(join(stubDir, "systemctl"), SYSTEMCTL_STUB_LINES);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * The one thing a comment could not keep true.
 *
 * Every blocking call in the hook is wrapped in a `timeout` (or curl's own `-m`) sized against the
 * wrapper unit's `TimeoutStartSec=`, and the script states that arithmetic in a comment. A comment
 * is not checked by anything: the plain-text retry added a SECOND curl without redoing the sum, and
 * the worst case went from 22s to a measured 32.04s against a 30s deadline. Overrunning it is not a
 * slow alert — systemd SIGTERMs the hook mid-send, so the message is lost AND
 * herald-notify-failure@<unit>.service itself enters `failed`, which is the one outcome a failure
 * handler must never produce.
 *
 * So the sum is computed here from the files themselves, including the CALL COUNTS, because it was
 * a call count that drifted and not a timeout value.
 */
describe("the hook fits inside its own TimeoutStartSec, with margin", () => {
  /** How much of the 30s must be left over for everything that is not a blocking call. Local text
   *  processing measures 0.07s end to end against an oversized 256 KiB journal window, so this is
   *  headroom for a loaded box and for the next thing someone adds, not for the current script. */
  const REQUIRED_MARGIN_SECONDS = 3;

  it("2 × journalctl + 1 × systemctl + 2 × curl still leaves room under the unit's deadline", async () => {
    const script = await readFile(REAL_SCRIPT_PATH, "utf8");
    const unit = await readFile(join(REPO_ROOT, "deploy", "herald-notify-failure@.service"), "utf8");

    const num = (re: RegExp, source: string, what: string): number => {
      const raw = re.exec(source)?.[1];
      expect(raw, `${what} is not written where this test can read it — update both`).toBeDefined();
      return Number(raw);
    };
    const deadline = num(/^TimeoutStartSec=(\d+)$/m, unit, "the wrapper unit's TimeoutStartSec=");
    const journalTimeout = num(/^JOURNAL_READ_TIMEOUT=(\d+)$/m, script, "JOURNAL_READ_TIMEOUT");
    const systemctlTimeout = num(/^SYSTEMCTL_READ_TIMEOUT=(\d+)$/m, script, "SYSTEMCTL_READ_TIMEOUT");
    const curlTimeout = num(/^\s*curl .*-m (\d+)/m, script, "curl's own -m");

    // Counted, not assumed. `journal_read --`, `systemctl_show "` and `send_telegram "` match call
    // sites only: the function definitions are `name() {`, with no space or quote after the name.
    const journalReads = (script.match(/journal_read --/g) ?? []).length;
    const systemctlReads = (script.match(/systemctl_show "/g) ?? []).length;
    const sends = (script.match(/send_telegram "/g) ?? []).length;
    // EVERY term needs this guard, not just two of them. A call written any other way — through a
    // variable, in a loop, renamed — is invisible to the regex above, and an invisible call counts
    // as zero: the term silently leaves the sum and the budget looks roomier than it is. That is the
    // same drift this whole test exists to catch, so a term that has disappeared must fail here
    // rather than quietly reduce the total. Verified by rewriting each call site through a variable
    // and confirming this test fails.
    expect(journalReads, "no journalctl call sites found — this test can no longer see them").toBeGreaterThan(0);
    expect(systemctlReads, "no systemctl call sites found — this test can no longer see them").toBeGreaterThan(0);
    expect(sends, "no send_telegram call sites found — this test can no longer see them").toBeGreaterThan(0);

    const worstCase = journalReads * journalTimeout + systemctlReads * systemctlTimeout + sends * curlTimeout;
    expect(
      worstCase,
      `worst case ${worstCase}s (${journalReads}×${journalTimeout} journalctl + ${systemctlReads}×` +
        `${systemctlTimeout} systemctl + ${sends}×${curlTimeout} curl) against TimeoutStartSec=${deadline}. ` +
        "Every one of these numbers is part of one sum; redo it in the script's budget comment and " +
        "in the unit file's before changing any of them.",
    ).toBeLessThanOrEqual(deadline - REQUIRED_MARGIN_SECONDS);
  });
});

describe("deploy/herald-notify-failure.sh", () => {
  it("sends a message containing the captured journal excerpt and the journalctl pointer, as valid JSON", async () => {
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status } = runScript(TEST_UNIT, {
      STUB_JOURNAL_OUTPUT: "collect: ok\ntranslate:prepare: FAILED (timeout)",
    });
    expect(status).toBe(0);

    const bodyRaw = await readFile(join(stubDir, "curl-body.log"), "utf8");
    const body = JSON.parse(bodyRaw) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-100999");
    expect(body.text).toContain(`⚠ ${TEST_UNIT} 실패`);
    expect(body.text).toContain("collect: ok");
    expect(body.text).toContain("translate:prepare: FAILED (timeout)");
    expect(body.text).toContain(`journalctl --user -u ${TEST_UNIT} -n 50 --no-pager`);
  });

  it("escapes quotes, backslashes and embedded newlines so the request body stays valid JSON", async () => {
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    // One literal double quote pair, one literal backslash, one embedded real newline — exactly
    // the three characters json_escape has to handle, at the "raw log text" level (not
    // pre-escaped JS-source noise, which is easy to double up by mistake).
    const nasty = 'claude -p reported: {"error":"bad quote and a backslash \\ end"}\nsecond line';
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: nasty });
    expect(status).toBe(0);

    const bodyRaw = await readFile(join(stubDir, "curl-body.log"), "utf8");
    // The whole point: this must not throw. A mutation that drops escaping produces a body
    // JSON.parse rejects outright.
    const body = JSON.parse(bodyRaw) as { text: string };
    // json_escape + JSON.parse should be exact inverses for quote/backslash/newline, so the
    // original raw text — quotes, backslash and the line break alike — must survive the round
    // trip byte-for-byte.
    expect(body.text).toContain(nasty);
  });

  it("falls back to a plain notice, still valid JSON, when neither the journal nor a run log has anything", async () => {
    // No run log is seeded here, so the log root does not even exist — the state on a box where
    // the failing unit never reached deploy/herald-run-logged.sh at all.
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
    expect(status).toBe(0);

    const bodyRaw = await readFile(join(stubDir, "curl-body.log"), "utf8");
    const body = JSON.parse(bodyRaw) as { text: string };
    expect(body.text).toContain("실행 로그도 저널도 남지 않았습니다");
    expect(body.text).toContain(`journalctl --user -u ${TEST_UNIT} -n 50 --no-pager`);
  });

  it("truncates an oversized excerpt so the message stays phone-readable", async () => {
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const huge = "x".repeat(2000) + "TAIL-MARKER";
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: huge });
    expect(status).toBe(0);

    const bodyRaw = await readFile(join(stubDir, "curl-body.log"), "utf8");
    const body = JSON.parse(bodyRaw) as { text: string };
    expect(body.text).toContain("(truncated)");
    // The tail — the most recent output — is what survives truncation, not the head.
    expect(body.text).toContain("TAIL-MARKER");
    expect(body.text.length).toBeLessThan(huge.length);
  });

  it("still exits 0 even when Telegram rejects the request", async () => {
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "collect: ok", STUB_CURL_EXIT: "22" });
    // The pre-existing, load-bearing guarantee this round's changes must not disturb: a
    // failure-handler that can itself fail is a loop, not a safety net.
    expect(status).toBe(0);
    expect(existsSync(join(stubDir, "curl-invoked"))).toBe(true);
  });

  it("sends nothing, and never invokes curl, when Telegram credentials are not configured", async () => {
    await writeSyntheticEnv({}); // no TELEGRAM_* lines at all
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "collect: ok" });
    expect(status).toBe(0);
    expect(existsSync(join(stubDir, "curl-invoked"))).toBe(false);
  });

  it("refuses to run, and never invokes curl or journalctl, when no unit name is given at all", async () => {
    // The old bug this replaces: a hardcoded UNIT meant a second consumer's failure was reported
    // under the first consumer's name. Falling back to an empty $UNIT here would trade that for a
    // quieter version of the same bug (see the script's own comment on its argument check), so a
    // missing $1 must refuse outright, not proceed with nothing.
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status, stderr } = runScript(undefined, { STUB_JOURNAL_OUTPUT: "collect: ok" });
    // Non-zero on purpose — this is a wiring mistake in the caller, not one of the downstream
    // conditions (Telegram down, credentials unset) this script otherwise absorbs by exiting 0.
    expect(status).not.toBe(0);
    expect(stderr).toContain("no unit name");
    expect(existsSync(join(stubDir, "curl-invoked"))).toBe(false);
  });

  // The durable run log — the actual payoff of deploy/herald-run-logged.sh existing, and (since this
  // task) the PRIMARY excerpt source, not a fallback for when the journal is empty. journald on this
  // box holds roughly eight minutes of history because it rotates on every backwards clock step, so
  // "captured immediately" buys nothing when the journal was already rotated *before* this hook ran:
  // a run that failed at minute nine of a thirty-minute TimeoutStartSec= has outlived its own
  // journal. Worse, journald attributes systemd's own post-exit chatter (`Main process exited`,
  // `Failed with result`, `Consumed … CPU time`, …) to the unit, and always last — so even a live
  // journal read spent its whole five-line budget on systemd talking about itself, never the
  // command's own output. The run log has neither problem: no rotation window, and nothing in it but
  // what the command printed plus the wrapper's own two boundary lines.
  describe("excerpt source: the run log is read first, the journal only as fallback", () => {
    it("prefers the durable run log over the journal, so systemd's own lines cannot crowd out the command's", async () => {
      // The 2026-08-07 alert this task's design doc is named for: journald attributes systemd's own
      // post-exit messages to the unit, and they are always last, so a five-line tail of the JOURNAL
      // is five lines of systemd talking about itself. The run log holds only what the command
      // printed. Both sources are seeded here, deliberately, so this proves precedence rather than
      // just "the run log is used when the journal has nothing" (the next test covers that).
      const runLog = await seedRunLog(
        TEST_UNIT,
        "20260807T094200Z",
        [
          "writing…",
          "  ✗ x:2085765414248968281 publish failed — HTTP 429",
          "wrote 0, retired 0, failed 1.",
          `=== ${TEST_UNIT} exited 1 at 2026-08-07T09:42:09Z ===`,
        ].join("\n") + "\n",
      );
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: [
          "herald-x-reconcile.service: Main process exited, code=exited, status=1/FAILURE",
          "herald-x-reconcile.service: Failed with result 'exit-code'.",
          "Failed to start herald-x-reconcile.service - Mantle KR Herald X publish reconcile.",
          "herald-x-reconcile.service: Triggering OnFailure= dependencies.",
          "herald-x-reconcile.service: Consumed 2.021s CPU time.",
        ].join("\n"),
      });
      expect(status).toBe(0);

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text, "the command's own failing line must be in the alert").toContain("HTTP 429");
      expect(body.text).toContain("wrote 0, retired 0, failed 1.");
      // The whole complaint, asserted directly.
      expect(body.text, "systemd's own noise must not appear").not.toContain("Consumed 2.021s CPU time");
      expect(body.text).not.toContain("Main process exited");
      expect(body.text).not.toContain("Triggering OnFailure=");
      // The pointer names the source that was actually used.
      expect(body.text).toContain(`tail -n 50 ${runLog}`);
      expect(body.text).not.toContain("journalctl --user -u");
    });

    it("falls back to the journal when there is no run log at all", async () => {
      // No seedRunLog call: this unit never reached the wrapper, so HERALD_LOG_DIR (a fresh per-test
      // temp directory, never created ahead of time — see beforeEach) has no entry for TEST_UNIT.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "the only record of this run\nsecond line",
      });
      expect(status).toBe(0);
      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("the only record of this run");
      expect(body.text).toContain("journalctl --user -u");
    });

    it("falls back to the journal when the run log exists but is empty", async () => {
      // A zero-byte file: the wrapper opened it and died before writing its header, or the disk
      // filled. `invocation: null` is what makes it genuinely empty — there is no header to carry an
      // id, which is also why the invocation gate refuses it. Both reasons point the same way here.
      await seedRunLog(TEST_UNIT, "20260807T094200Z", "", { invocation: null });
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "journal had it" });
      expect(status).toBe(0);
      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("journal had it");
    });

    it("uses the run log's tail when the journal comes back empty, and points at the file", async () => {
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const runLog = await seedRunLog(
        TEST_UNIT,
        "20260808T004126Z",
        "x:reconcile: reading @0xMantleKR\nx:reconcile: FAILED — ECONNREFUSED\n",
      );
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      expect(status).toBe(0);

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain(`⚠ ${TEST_UNIT} 실패`);
      expect(body.text).toContain("ECONNREFUSED");
      // Pointing at `journalctl` here would send the reader to the one place already known to be
      // empty. The path is the whole point of the fallback.
      expect(body.text).toContain(`tail -n 50 ${runLog}`);
      expect(body.text).not.toContain("실행 로그도 저널도 남지 않았습니다");
    });

    it("reads only the failing unit's own run logs", async () => {
      // Same hazard the hook was templated for in the first place: reporting one unit's failure
      // with another unit's output. The per-unit directory is what prevents it here.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog("herald-watch.service", "20260808T021700Z", "watch: FAILED — wrong unit\n");
      await seedRunLog(TEST_UNIT, "20260808T004126Z", "reconcile: FAILED — right unit\n");
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("right unit");
      expect(body.text).not.toContain("wrong unit");
    });

    it("picks the newest run log by name, not by mtime", async () => {
      // This box's clock steps constantly — it is why the journal is unusable in the first place —
      // so mtime ordering is exactly the thing that cannot be trusted here. The two files below are
      // seeded with mtimes in the opposite order to their names; a `ls -t` implementation picks the
      // older run and reports a failure that already happened.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260808T004126Z", "the newer run\n", { mtime: new Date("2020-01-01T00:00:00Z") });
      await seedRunLog(TEST_UNIT, "20260807T184126Z", "the older run\n", { mtime: new Date("2030-01-01T00:00:00Z") });
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("the newer run");
      expect(body.text).not.toContain("the older run");
    });

    it("prefers the run log when it has lines, even though the journal also has content", async () => {
      // Inverted by this task, on purpose: before Task 1 this test asserted the opposite (the
      // journal won this race) because the journal was read first. That was the exact bug — see the
      // "prefers the durable run log over the journal" test above — so this assertion is now
      // backwards from what it used to be, not weakened from it.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const runLog = await seedRunLog(TEST_UNIT, "20260808T004126Z", "from the run log\n");
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "from the journal" });

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("from the run log");
      expect(body.text).not.toContain("from the journal");
      expect(body.text).toContain(`tail -n 50 ${runLog}`);
    });

    it("truncates an oversized run-log excerpt the same way it truncates a journal one", async () => {
      // The 500-character phone budget applies to whichever source answered — the truncation step
      // runs after the fallback, not before it, and a run log is if anything the more likely of the
      // two to carry a full stack trace.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260808T004126Z", "y".repeat(2000) + "RUNLOG-TAIL-MARKER\n");
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("(truncated)");
      expect(body.text).toContain("RUNLOG-TAIL-MARKER");
      expect(body.text.length).toBeLessThan(2000);
    });

    it("still exits 0 when the run log directory is unreadable", async () => {
      // The never-fatal contract covers the new code path too: a failure handler that can itself
      // fail is a loop, not a safety net. Blocked with a regular file where a directory component
      // has to be, so this holds even if the suite runs as root.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const blocker = join(workDir, "blocker");
      await writeFile(blocker, "not a directory\n", "utf8");
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        HERALD_LOG_DIR: join(blocker, "logs"),
      });
      expect(status).toBe(0);

      const body = JSON.parse(await readFile(join(stubDir, "curl-body.log"), "utf8")) as { text: string };
      expect(body.text).toContain("실행 로그도 저널도 남지 않았습니다");
    });
  });

  it("refuses to run the same way when the unit name is present but empty", async () => {
    // `""` is not "absent" to bash's `${1:-}` unless the caller also fails to pass an argument at
    // all — both must be refused, since both leave $UNIT with nothing to name or tail.
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status, stderr } = runScript("", { STUB_JOURNAL_OUTPUT: "collect: ok" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("no unit name");
    expect(existsSync(join(stubDir, "curl-invoked"))).toBe(false);
  });

  // The alert's shape: `parse_mode: "HTML"` makes the message *rejectable*, not just prettier. An
  // unescaped `<` in a log line makes malformed HTML, Telegram answers 400, and `curl -fsS … ||
  // true` used to discard that silently — the alert simply never arrived, at either end. Escaping
  // and the plain-text retry are two halves of one guard, proven here by actually running the
  // script against a stub that rejects the first attempt, not by asserting the code path exists.
  describe("the HTML alert, and its plain-text retry", () => {
    it("sends HTML: a monospace excerpt, an escaped body, and a header naming the exit code", async () => {
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      // The exit line is deliberately included — EXIT_CODE otherwise depends on `systemctl --user
      // show` finding a real unit, which a synthetic TEST_UNIT never is. Seeding the wrapper's own
      // boundary line is what makes "a header naming the exit code" a fact about this test rather
      // than a fact about whatever happens to be running on the box that executes it.
      await seedRunLog(
        TEST_UNIT,
        "20260810T060000Z",
        [
          "  ✓ live: google_drive_review  reachable",
          "  ✗ live: google_auth          400 <invalid_grant> & dead",
          "6 ok · 0 warn · 1 fail",
          `=== ${TEST_UNIT} exited 1 at 2026-08-10T06:00:09Z ===`,
        ].join("\n") + "\n",
      );
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      expect(status).toBe(0);

      const body = await readCurlBody();
      const payload = JSON.parse(body) as { text: string; parse_mode?: string };

      expect(payload.parse_mode).toBe("HTML");
      expect(payload.text).toMatch(/^⚠ .*실패/);
      expect(payload.text).toContain("(exit 1)");
      expect(payload.text).toContain("<pre>");
      expect(payload.text).toContain("</pre>");
      // Escaped, or Telegram 400s and the alert vanishes.
      expect(payload.text).toContain("400 &lt;invalid_grant&gt; &amp; dead");
      expect(payload.text, "the raw form must not survive").not.toContain("<invalid_grant>");
      expect(payload.text).toContain("↳ ");
    });

    it("escapes a literal `</pre>` in a log line so it cannot close the real block early", async () => {
      // The design doc for this task calls this out by name as a hazard distinct from an ordinary
      // `<`: an unescaped `</pre>` in the excerpt would close OUR tag early and dump everything
      // after it — including the pointer line — as unformatted text sitting outside any block.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060050Z", "payload said </pre><script>evil</script>\n");
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      expect(status).toBe(0);

      const payload = JSON.parse(await readCurlBody()) as { text: string };
      // Exactly one real <pre> and one real </pre> — the pair this script itself inserts around the
      // excerpt. More than one of either means a tag from the log content survived escaping.
      expect(payload.text.match(/<pre>/g)).toHaveLength(1);
      expect(payload.text.match(/<\/pre>/g)).toHaveLength(1);
      expect(payload.text).toContain("payload said &lt;/pre&gt;&lt;script&gt;evil&lt;/script&gt;");
    });

    /**
     * The fixture the retry tests share, and every character of it is load-bearing.
     *
     * `<`, `>` and `&` are the three characters html_escape touches. `&lt;`, printed literally by
     * the command, is the fourth case and the one that makes the un-escape's ORDER observable:
     * html_escape turns it into `&amp;lt;`, and only un-escaping `&lt;`/`&gt;` BEFORE `&amp;`
     * returns the `&lt;` the command actually printed. Do it the other way round and `&amp;lt;`
     * collapses to `&lt;` and then to `<` — a character that was never in the log.
     *
     * Before this fixture existed the retry's only content was the string "something broke", which
     * contains none of these. Two separate mutations of the un-escape — reversing its order, and
     * DELETING IT ENTIRELY — left the whole suite green. Deleting it ships `400 &lt;invalid_grant&gt;
     * &amp; dead` as the PLAIN-TEXT retry, i.e. the retry sends the operator raw entity noise, when
     * making a rejected message readable is the only thing the retry is for.
     */
    const RETRY_FIXTURE = "✗ live: google_auth 400 <invalid_grant> & dead (literal &lt; kept)";

    it("retries as plain text when Telegram rejects the HTML, un-escaping exactly what it escaped", async () => {
      // A stray `<` that escaping missed must cost one message's formatting, not the message.
      // curl's own `|| true` already discards the failure, so without the retry the alert is
      // simply gone — proven here by execution, not by inspecting the code path.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060100Z", RETRY_FIXTURE + "\n");
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_CURL_EXIT: "22", // curl -f: HTTP error
      });
      // The hook must still reach exit 0 even though both curl attempts below "fail" — an alert
      // failure must never fail the systemd unit that ran it.
      expect(status).toBe(0);

      const bodies = await readAllCurlBodies();
      expect(bodies, "one HTML attempt, then one plain retry").toHaveLength(2);
      const first = JSON.parse(bodies[0]) as { parse_mode?: string; text: string };
      const second = JSON.parse(bodies[1]) as { parse_mode?: string; text: string };
      expect(first.parse_mode).toBe("HTML");
      // What the HTML attempt sent: every entity escaped, including the `&` of the log's own
      // literal `&lt;`, which is what makes the retry's order matter at all.
      expect(first.text).toContain("400 &lt;invalid_grant&gt; &amp; dead (literal &amp;lt; kept)");

      expect(second.parse_mode, "the retry must not ask for HTML again").toBeUndefined();
      expect(second.text, "tags stripped, content kept").not.toContain("<pre>");
      // The round trip, asserted exactly: the plain retry must carry the log line the command
      // actually printed, byte for byte. `&amp;lt;` must come back as `&lt;`, NOT as `<`.
      expect(second.text, "the plain retry must reproduce the log line verbatim").toContain(RETRY_FIXTURE);
      expect(second.text, "an entity survived into the plain-text retry").not.toContain("&amp;");
      expect(second.text).not.toContain("&gt;");
      expect(second.text, "the literal &lt; was un-escaped one step too far").not.toContain("literal < kept");
    });

    it("lands the retry: rejects the HTML attempt, accepts the plain one", async () => {
      // `STUB_CURL_EXIT` rejects BOTH attempts, so on its own it proves only that a retry is
      // ATTEMPTED. The retry exists to make a rejected message ARRIVE, and a retry nobody has
      // watched succeed is the thing this whole task is about. `22 0` is the real sequence: Telegram
      // 400s the HTML, then accepts the same content as plain text.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060130Z", RETRY_FIXTURE + "\n");
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_CURL_EXITS: "22 0",
      });
      expect(status).toBe(0);

      const bodies = await readAllCurlBodies();
      // Exactly two: the rejected HTML attempt and the accepted plain one. A third would mean the
      // "one retry, not a loop" bound is gone.
      expect(bodies, "one rejected HTML attempt, then one accepted plain retry").toHaveLength(2);
      const accepted = JSON.parse(bodies[1]) as { parse_mode?: string; text: string };
      expect(accepted.parse_mode).toBeUndefined();
      expect(accepted.text, "what actually reached the operator").toContain(RETRY_FIXTURE);
      expect(accepted.text).not.toContain("<pre>");
      expect(accepted.text).toMatch(/^⚠ .*실패/);
      expect(accepted.text).toContain("↳ ");
    });

    it("does not retry a failure a plain-text resend could not possibly fix", async () => {
      // The retry is gated on curl's 22 — `-f` saw an HTTP status >= 400 — and on nothing else.
      // 6 is DNS, 28 is `-m` expiring, 127 is curl not installed. None of them is about the
      // message's formatting, so a second attempt cannot help; it can only spend the curl budget
      // twice against this hook's own TimeoutStartSec=30 (the measured 32.04s overrun), and 28 can
      // outright DUPLICATE the alert when `-m` expires after Telegram already accepted the message.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      for (const code of ["6", "28", "127"]) {
        await rm(join(stubDir, "curl-body.log"), { force: true });
        await rm(join(stubDir, "curl-calls"), { force: true });
        await seedRunLog(TEST_UNIT, "20260810T060150Z", "something broke\n");
        const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "", STUB_CURL_EXIT: code });
        expect(status, `curl exit ${code} must not fail the hook`).toBe(0);
        expect(await readAllCurlBodies(), `curl exit ${code} must not be retried`).toHaveLength(1);
      }
    });

    it("does not retry when the first send succeeds", async () => {
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060200Z", "something broke\n");
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      expect(status).toBe(0);
      expect(await readAllCurlBodies()).toHaveLength(1);
    });
  });

  /**
   * Proving the run log is THIS run's, which is what makes reading it first safe at all.
   *
   * "Newest by name" is not "this run's". They come apart exactly when the unit fails WITHOUT
   * reaching deploy/herald-run-logged.sh — a 203/EXEC because pnpm moved, a bad ExecStart=, an
   * unwritable log root — because then nothing is written for this run and the newest file is the
   * PREVIOUS run's, output and `exited <n>` footer intact. The alert reported yesterday's failure,
   * with yesterday's exit code, as today's, and discarded today's real status. Nothing in the file's
   * name, mtime or content could tell the two apart; systemd's invocation id can, because it changes
   * on every start of the unit.
   *
   * The rule is all-or-nothing: an unverifiable file is dropped for the excerpt AND the exit code.
   * Both came from the same stale file, so a gate that saved only the number would still have
   * shipped yesterday's output under today's date.
   */
  describe("the run log is used only when it can be proven to be this run's", () => {
    it("does not report a previous run's output or exit code when this run never wrote a log", async () => {
      // The scenario in full, exactly as it was reported. A stale run log with footer `exited 1`
      // sits in the directory; today the unit died at 203/EXEC before the wrapper could run, so
      // there is no log for it and the journal is the only record. The alert must be today's.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const stale = await seedRunLog(
        TEST_UNIT,
        "20260809T070000Z",
        `yesterday: collect failed, 3 items lost\n=== ${TEST_UNIT} exited 1 at 2026-08-09T07:00:09Z ===\n`,
        { invocation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, // a PREVIOUS start of the unit
      );
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: `${TEST_UNIT}: Failed to execute /home/kyle/.herald/bin/pnpm: No such file or directory`,
        STUB_INVOCATION_ID: TEST_INVOCATION_ID, // systemd's answer for the run that just failed
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "203",
      });
      expect(status).toBe(0);

      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text, "yesterday's exit code must not be presented as today's").not.toContain("(exit 1)");
      expect(payload.text, "yesterday's output must not be presented as today's").not.toContain(
        "yesterday: collect failed",
      );
      expect(payload.text, "the pointer must not send the reader to a file about another run").not.toContain(stale);
      // What today actually was, from the only source that has it.
      expect(payload.text).toContain("(exit 203)");
      expect(payload.text).toContain("No such file or directory");
      expect(payload.text).toContain(`journalctl --user -u ${TEST_UNIT}`);
    });

    it("uses the run log when the ids match", async () => {
      // The other half, so the gate cannot pass by refusing everything.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const runLog = await seedRunLog(TEST_UNIT, "20260810T070000Z", "today: the real failure\n");
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "systemd noise nobody wants",
        STUB_INVOCATION_ID: TEST_INVOCATION_ID,
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain("today: the real failure");
      expect(payload.text).toContain(`tail -n 50 ${runLog}`);
      expect(payload.text).not.toContain("systemd noise");
    });

    it("refuses a run log written before the wrapper recorded an invocation id", async () => {
      // Deliberate, and stated in the script's own comment so nobody "fixes" it by trusting them:
      // an id-less log cannot be attributed to any run, and trusting it is the bug. The transition
      // ages itself out — herald-run-logged.sh keeps 60 runs per unit and these units run daily.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T070000Z", "an old log, from before the id existed\n", {
        invocation: null,
      });
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "the journal still has today" });
      expect(status).toBe(0);
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).not.toContain("an old log");
      expect(payload.text).toContain("the journal still has today");
    });

    it("refuses a run log whose header says `none` — the wrapper run outside systemd", async () => {
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T070000Z", "someone ran the wrapper by hand\n", {
        invocation: "none",
      });
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "the journal still has today" });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).not.toContain("by hand");
      expect(payload.text).toContain("the journal still has today");
    });

    it("takes the journal when systemd cannot be asked at all, rather than an unverifiable file", async () => {
      // No bus, no user manager, the 2s timeout expiring: nothing can be verified, so nothing on
      // disk may be trusted. Losing the run log's formatting is survivable; presenting yesterday's
      // failure as today's is not. Note the run log here is otherwise PERFECTLY GOOD — it is the
      // inability to check that decides, not anything about the file.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T070000Z", "a run log nobody can vouch for\n");
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "the journal, unverified but current",
        STUB_SYSTEMCTL_SILENT: "1",
      });
      expect(status).toBe(0);
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).not.toContain("nobody can vouch for");
      expect(payload.text).toContain("the journal, unverified but current");
    });

    it("takes the journal when systemd reports no invocation for the unit", async () => {
      // An empty InvocationID is what systemd prints for a unit it has never heard of — measured on
      // a live box. Empty must never compare equal to a file that also records nothing.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T070000Z", "a run log for a unit systemd forgot\n", {
        invocation: null,
      });
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "the journal",
        STUB_INVOCATION_ID: "", // explicitly empty, the unknown-unit answer
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text, "empty must not verify empty").not.toContain("systemd forgot");
      expect(payload.text).toContain("the journal");
    });

    it("only reads the header from the first line, not from output that imitates it", async () => {
      // A command echoing a line shaped like the wrapper's header — replaying a previous log, say —
      // must not be able to vouch for a file the wrapper never headed.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(
        TEST_UNIT,
        "20260810T070000Z",
        `replaying: ${wrapperHeader(TEST_UNIT)}\n${wrapperHeader(TEST_UNIT)}\nforged content\n`,
        { invocation: null },
      );
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "the journal" });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).not.toContain("forged content");
      expect(payload.text).toContain("the journal");
    });

    it("the wrapper writes a header this hook accepts — the real one, end to end", async () => {
      // The coupling, run rather than spelled. deploy/herald-run-logged.sh composes the header and
      // deploy/herald-notify-failure.sh parses it; they are two bash files that cannot import each
      // other, so a change to either side's format would otherwise leave both suites green while
      // every alert in production silently fell back to the journal. Same shape as the LOG_ROOT and
      // ALERT_MARKER couplings this repo already pins.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const invocation = "0badc0de0badc0de0badc0de0badc0de";
      const wrapper = spawnSync(
        "bash",
        [join(REPO_ROOT, "deploy", "herald-run-logged.sh"), TEST_UNIT, "/bin/bash", "-c", "echo the real thing; exit 1"],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            HERALD_LOG_DIR: logRoot,
            INVOCATION_ID: invocation,
          },
          encoding: "utf8",
        },
      );
      expect(wrapper.status, wrapper.stderr).toBe(1); // the command's own code, unchanged

      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "the journal", STUB_INVOCATION_ID: invocation });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text, "the hook rejected a log the real wrapper just wrote").toContain("the real thing");
      expect(payload.text).toContain("(exit 1)");
      expect(payload.text).not.toContain("the journal");
    });

    it("the wrapper records `none`, not a broken header, when it runs outside systemd", async () => {
      // INVOCATION_ID unset is a hand run. The header must still be one parseable line — a value
      // with a space in it would corrupt the field the hook reads — and must not verify.
      const wrapper = spawnSync(
        "bash",
        [join(REPO_ROOT, "deploy", "herald-run-logged.sh"), TEST_UNIT, "/bin/bash", "-c", "echo hand run"],
        { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, HERALD_LOG_DIR: logRoot }, encoding: "utf8" },
      );
      expect(wrapper.status).toBe(0);
      expect(wrapper.stdout).toContain(`=== ${TEST_UNIT} started `);
      expect(wrapper.stdout).toContain("invocation none —");
      expect(wrapper.stdout, "a hand run must not look like a systemd invocation").not.toMatch(
        /invocation [0-9a-f]{8} /,
      );
    });
  });

  /**
   * The exit code in the header, and which of the two sources gets to name it.
   *
   * `⚠ <unit> 실패 (exit 2)` is the difference between "a credential died" and "this machine is
   * misconfigured", read before the body. It is also the one line in the alert that can be
   * confidently, specifically WRONG — and it was: the first implementation asked
   * `systemctl --user show <unit> -p ExecMainStatus --value` first and treated an empty answer as
   * "unknown", but that call never returns empty. For a unit systemd cannot account for it prints
   * `0` and exits 0, so the header rendered `(exit 0)` on a failure alert and the run-log fallback
   * underneath it was unreachable. Every test below drives the systemctl stub deliberately, because
   * the branch that produced that bug is the branch that runs in production.
   */
  describe("the exit code in the header", () => {
    const RUN_LOG_STAMP = "20260810T070000Z";

    it("prefers the run log's own footer over systemd's account of the run", async () => {
      // Both sources answer, and they disagree. The wrapper's footer is our own artifact, written
      // from ${PIPESTATUS[0]} by the process that actually ran the command; ExecMainStatus is
      // systemd's account of it, and the same reasoning Task 1 applied to the excerpt applies here.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(
        TEST_UNIT,
        RUN_LOG_STAMP,
        `boom\n=== ${TEST_UNIT} exited 2 at 2026-08-10T07:00:09Z ===\n`,
      );
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "9", // systemd's answer, which must lose
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain(`⚠ ${TEST_UNIT} 실패 (exit 2)`);
      expect(payload.text).not.toContain("(exit 9)");
    });

    it("asks systemd only when the run log has no footer — a run killed before it could write one", async () => {
      // TimeoutStartSec= kills the whole cgroup, wrapper included, so `=== … exited … ===` is
      // exactly the line a wedged run does not leave behind. That is the case the fallback is for.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, RUN_LOG_STAMP, "still working…\n");
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_EXEC_MAIN_CODE: "1", // CLD_EXITED: ExecMainStatus is a real exit status
        STUB_EXEC_MAIN_STATUS: "2",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain(`⚠ ${TEST_UNIT} 실패 (exit 2)`);
    });

    it("reads systemd's answer by name, not by position", async () => {
      // The stub prints ExecMainStatus first and ExecMainCode second — the reverse of the order the
      // script asks for them in, and the same thing real systemctl does (it emits properties in its
      // own order). Read positionally, this run sees code=2/status=1 and renders `(exit 129)`.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "no run log at all",
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "2",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain("(exit 2)");
      expect(payload.text).not.toContain("(exit 129)");
    });

    it("renders a killed process as 128+signal, the number the wrapper's footer would have said", async () => {
      // ExecMainCode 2 is CLD_KILLED, and then ExecMainStatus is a SIGNAL NUMBER, not a status. A
      // unit killed on its own TimeoutStartSec= reports 15 — and `(exit 15)` names a code the
      // command never returned, while herald-run-logged.sh, for the very same run, would have
      // written 143. Two sources for one number must not disagree about what the number means.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, RUN_LOG_STAMP, "wedged, and killed before the footer\n");
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_EXEC_MAIN_CODE: "2",
        STUB_EXEC_MAIN_STATUS: "15",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain("(exit 143)");
      expect(payload.text, "15 is the signal, not the status").not.toContain("(exit 15)");
    });

    it("names no exit code at all when systemd cannot account for the unit", async () => {
      // THE PRODUCTION BUG, as a test. `ExecMainCode=0` / `ExecMainStatus=0` is verbatim what a
      // real `systemctl --user show` prints for a unit it has never heard of — measured on a live
      // box, exit 0, not empty. The old guard only rejected non-numeric answers, so it accepted
      // that `0` and the alert read `실패 (exit 0)`: a header contradicting itself about a real
      // failure. Unknown must degrade to a header with NO code, which is what the script's own
      // comment always claimed and did not do.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "the journal is all there is",
        STUB_EXEC_MAIN_CODE: "0",
        STUB_EXEC_MAIN_STATUS: "0",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain(`⚠ ${TEST_UNIT} 실패\n`);
      expect(payload.text, "a failure alert must never claim exit 0").not.toContain("(exit");
    });

    it("never renders (exit 0), even when systemd reports a genuine zero status", async () => {
      // ExecMainCode=1 says "this really is an exit status", and it is 0. The unit still failed —
      // that is why this hook is running — so 0 is not information, it is a contradiction, and the
      // reader gets no code rather than a wrong one.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "boom",
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "0",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).not.toContain("(exit 0)");
      expect(payload.text).toContain(`⚠ ${TEST_UNIT} 실패\n`);
    });

    it("still sends, and still exits 0, when systemctl cannot answer at all", async () => {
      // A box where systemctl exists but there is no user manager to ask — a container, CI, a
      // session whose bus has gone. The call exits non-zero with nothing on stdout. The alert must
      // lose its exit code, not its message, and the hook must still reach exit 0.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      const { status } = runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "boom",
        STUB_SYSTEMCTL_SILENT: "1",
      });
      expect(status).toBe(0);
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain(`⚠ ${TEST_UNIT} 실패\n`);
      expect(payload.text).toContain("boom");
    });

    it("takes the footer's number literally, including a three-digit one", async () => {
      // 143 is TimeoutStartSec= killing a wedged run, as herald-run-logged.sh records it. A parser
      // that grabbed one digit, or that matched `exited <n>` without anchoring the ` at ` after it,
      // reports 1.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(
        TEST_UNIT,
        RUN_LOG_STAMP,
        `wedged\n=== ${TEST_UNIT} exited 143 at 2026-08-10T07:30:00Z ===\n`,
      );
      runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text).toContain("(exit 143)");
    });

    it("only accepts the footer at the start of a line, not quoted inside one", async () => {
      // The wrapper's boundary line is written at column 0. A command that PRINTS something looking
      // like one — an error message quoting a previous run, a test fixture, a copied log — must not
      // get to set the header's exit code. Same anchoring the run-scoping awk uses on the journal.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(
        TEST_UNIT,
        RUN_LOG_STAMP,
        `error: previous log said "=== ${TEST_UNIT} exited 9 at 2026-08-09T07:00:09Z ==="\n`,
      );
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "1",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text, "a quoted footer is not this run's footer").not.toContain("(exit 9)");
      expect(payload.text).toContain("(exit 1)");
    });

    it("does not let a unit name's dots match other units' footers", async () => {
      // `$UNIT` used to be interpolated straight into a sed BRE, where every `.` in
      // `herald-x-reconcile.service` is a wildcard (and a `/` would have closed the s/// delimiter).
      // Not exploitable — systemd unit names are not attacker input — but the neighbouring awk uses
      // `-v` precisely so that no interpolation is ever a pattern, and this one now does too.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(
        TEST_UNIT,
        RUN_LOG_STAMP,
        // Same name with the dot replaced: a literal match rejects it, a BRE wildcard accepts it.
        `boom\n=== herald-x-reconcileXservice exited 7 at 2026-08-10T07:00:09Z ===\n`,
      );
      runScript(TEST_UNIT, {
        STUB_JOURNAL_OUTPUT: "",
        STUB_EXEC_MAIN_CODE: "1",
        STUB_EXEC_MAIN_STATUS: "1",
      });
      const payload = JSON.parse(await readCurlBody()) as { text: string };
      expect(payload.text, "another unit's footer must not name this unit's exit code").not.toContain("(exit 7)");
      expect(payload.text).toContain("(exit 1)");
    });
  });
});
