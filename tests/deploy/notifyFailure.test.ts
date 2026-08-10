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
 *  retries once when Telegram rejects the HTML — and exits with $STUB_CURL_EXIT (default 0), lets
 *  tests simulate Telegram accepting or rejecting the request without a real network call.
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
  'exit "${STUB_CURL_EXIT:-0}"',
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
 * Writes a durable run log for `unit` under the stand-in log root, named the way
 * deploy/herald-run-logged.sh names one. `mtime` is settable so a test can invert the mtime order
 * against the name order — see the test that relies on it.
 */
async function seedRunLog(unit: string, stamp: string, body: string, mtime?: Date): Promise<string> {
  const dir = join(logRoot, unit.replace(/\.service$/, ""));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}.log`);
  await writeFile(path, body, "utf8");
  if (mtime) await utimes(path, mtime, mtime);
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
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
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
          `=== ${TEST_UNIT} started 2026-08-07T09:42:00Z — pnpm x:reconcile --yes ===`,
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
      await seedRunLog(TEST_UNIT, "20260807T094200Z", "");
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
      await seedRunLog(TEST_UNIT, "20260808T004126Z", "the newer run\n", new Date("2020-01-01T00:00:00Z"));
      await seedRunLog(TEST_UNIT, "20260807T184126Z", "the older run\n", new Date("2030-01-01T00:00:00Z"));
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

    it("retries once as plain text when Telegram rejects the HTML", async () => {
      // A stray `<` that escaping missed must cost one message's formatting, not the message.
      // curl's own `|| true` already discards the failure, so without the retry the alert is
      // simply gone — proven here by execution, not by inspecting the code path.
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060100Z", "something broke\n");
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
      expect(second.parse_mode, "the retry must not ask for HTML again").toBeUndefined();
      expect(second.text, "tags stripped, content kept").not.toContain("<pre>");
      expect(second.text).toContain("something broke");
    });

    it("does not retry when the first send succeeds", async () => {
      await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
      await seedRunLog(TEST_UNIT, "20260810T060200Z", "something broke\n");
      const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
      expect(status).toBe(0);
      expect(await readAllCurlBodies()).toHaveLength(1);
    });
  });
});
