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
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../src/paths";

const TEST_UNIT = "herald-x-reconcile.service";
const REAL_SCRIPT_PATH = join(REPO_ROOT, "deploy", "herald-notify-failure.sh");
const REAL_REPO_DIR_LINE = 'REPO_DIR="/home/kyle/code/mantle-kr-herald"';

let workDir: string;
let repoDir: string;
let stubDir: string;
let scriptPath: string;

/** curl stub: records the JSON body (the argument immediately after `-d`) to curl-body.log, and
 *  exits with $STUB_CURL_EXIT (default 0) — lets tests simulate Telegram accepting or rejecting
 *  the request without a real network call. */
const CURL_STUB_LINES = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'BODY_LOG="$STUB_DIR/curl-body.log"',
  ': > "$STUB_DIR/curl-invoked"',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "-d" ]; then',
  '    printf %s "$arg" > "$BODY_LOG"',
  "  fi",
  '  prev="$arg"',
  "done",
  'exit "${STUB_CURL_EXIT:-0}"',
];

/** journalctl stub: prints $STUB_JOURNAL_OUTPUT (may be unset/empty) verbatim and exits
 *  $STUB_JOURNAL_EXIT (default 0) — the script under test always calls it the same way
 *  (`--user -u <unit> -n N --no-pager --output=cat`), so there is nothing else to branch on. */
const JOURNALCTL_STUB_LINES = [
  "#!/usr/bin/env bash",
  'printf %s "${STUB_JOURNAL_OUTPUT:-}"',
  'exit "${STUB_JOURNAL_EXIT:-0}"',
];

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  await chmod(path, 0o755);
}

async function writeSyntheticEnv(vars: Record<string, string>): Promise<void> {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writeFile(join(repoDir, ".env"), body + "\n", "utf8");
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
    expect(body.text).toContain(`⚠ ${TEST_UNIT} failed`);
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

  it("falls back to a plain notice, still valid JSON, when journalctl returns nothing", async () => {
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status } = runScript(TEST_UNIT, { STUB_JOURNAL_OUTPUT: "" });
    expect(status).toBe(0);

    const bodyRaw = await readFile(join(stubDir, "curl-body.log"), "utf8");
    const body = JSON.parse(bodyRaw) as { text: string };
    expect(body.text).toContain("no journal lines captured");
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

  it("refuses to run the same way when the unit name is present but empty", async () => {
    // `""` is not "absent" to bash's `${1:-}` unless the caller also fails to pass an argument at
    // all — both must be refused, since both leave $UNIT with nothing to name or tail.
    await writeSyntheticEnv({ TELEGRAM_BOT_TOKEN: "123:AA-token", TELEGRAM_CHAT_ID_OPS: "-100999" });
    const { status, stderr } = runScript("", { STUB_JOURNAL_OUTPUT: "collect: ok" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("no unit name");
    expect(existsSync(join(stubDir, "curl-invoked"))).toBe(false);
  });
});
