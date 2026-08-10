// tests/deploy/notifyFailureMarker.test.ts
//
// The marked-line mechanism in deploy/herald-notify-failure.sh, driven the same way
// tests/deploy/notifyFailure.test.ts drives the rest of that script: a throwaway copy with REPO_DIR
// repointed at a synthetic repo, stub `curl`/`journalctl` ahead of everything on PATH, so the real
// script's real grep/sed/tail run while no HTTP call and no real journal read happen.
//
// Why the mechanism exists, in one sentence: the message is built from the last LOG_TAIL_LINES lines
// of a unit's output, and `pnpm creds:check` is the first unit whose important line is at the top —
// its `✗` naming the dead credential sat nine rows from the end and the alert carried two green
// ticks and a count. Printing a summary last fixed that and left one line of slack, which systemd's
// own failure lines spend entirely on the journal branch. Counting lines from the end is a
// positional heuristic; this file is about the property that replaced it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../src/paths";
import { ALERT_MARKER } from "../../src/deploy/alertMarker";

const TEST_UNIT = "herald-creds.service";
const REAL_SCRIPT_PATH = join(REPO_ROOT, "deploy", "herald-notify-failure.sh");
const REAL_REPO_DIR_LINE = 'REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"';

const CURL_STUB_LINES = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "-d" ]; then printf %s "$arg" > "$STUB_DIR/curl-body.log"; fi',
  '  prev="$arg"',
  "done",
  "exit 0",
];
const JOURNALCTL_STUB_LINES = ["#!/usr/bin/env bash", 'printf %s "${STUB_JOURNAL_OUTPUT:-}"', "exit 0"];

let workDir: string;
let repoDir: string;
let stubDir: string;
let scriptPath: string;
let logRoot: string;

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  await chmod(path, 0o755);
}

async function seedRunLog(unit: string, body: string): Promise<string> {
  const dir = join(logRoot, unit.replace(/\.service$/, ""));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "20260810T062300Z.log");
  await writeFile(path, body, "utf8");
  return path;
}

/** Runs the script and returns the Telegram message text it would have sent, or undefined. */
function sentText(journal: string): string | undefined {
  const result = spawnSync("bash", [scriptPath, TEST_UNIT], {
    env: {
      PATH: `${stubDir}:/usr/bin:/bin`,
      STUB_DIR: stubDir,
      HOME: process.env.HOME,
      HERALD_LOG_DIR: logRoot,
      STUB_JOURNAL_OUTPUT: journal,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const bodyPath = join(stubDir, "curl-body.log");
  try {
    const body = JSON.parse(readFileSync(bodyPath, "utf8")) as { text: string };
    return body.text;
  } catch {
    return undefined;
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "herald-notify-marker-test-"));
  repoDir = join(workDir, "repo");
  stubDir = join(workDir, "stubs");
  logRoot = join(workDir, "logs");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await writeFile(join(repoDir, ".env"), "TELEGRAM_BOT_TOKEN=stub\nTELEGRAM_CHAT_ID_OPS=-100999\n", "utf8");

  const real = await readFile(REAL_SCRIPT_PATH, "utf8");
  expect(real, "REPO_DIR line moved — update this test's repoint logic to match").toContain(REAL_REPO_DIR_LINE);
  scriptPath = join(workDir, "herald-notify-failure.sh");
  await writeExecutable(scriptPath, real.replace(REAL_REPO_DIR_LINE, `REPO_DIR="${repoDir}"`).split("\n"));
  await writeExecutable(join(stubDir, "curl"), CURL_STUB_LINES);
  await writeExecutable(join(stubDir, "journalctl"), JOURNALCTL_STUB_LINES);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A report-shaped run, with the marked summary last, followed by however many trailing lines. */
function credsRun(trailing: string[]): string {
  return [
    "=== herald-creds.service started 2026-08-10T06:23:00Z — pnpm creds:check ===",
    "Mantle KR Herald — credential liveness (https://mantle-kr-herald.vercel.app)",
    "",
    "  ✗ live: google_auth            HTTP 401 invalid_grant",
    "  ✓ live: google_drive_review    reachable",
    "  ✓ live: google_drive_approved  reachable",
    "  ✓ live: lark                   tenant token issued",
    "  ✓ live: typefully              social set reachable",
    "  ✓ live: telegram               bot token valid",
    "  ✓ live: google_sheets          reachable",
    "",
    "6 ok · 0 warn · 1 fail",
    `${ALERT_MARKER}✗ FAILED: live: google_auth`,
    "=== herald-creds.service exited 1 at 2026-08-10T06:23:04Z ===",
    ...trailing,
  ].join("\n");
}

describe("the marker is one decision in two files", () => {
  it("bash and TypeScript spell it identically", async () => {
    // deploy/herald-notify-failure.sh cannot import src/deploy/alertMarker.ts, so the two spellings
    // are pinned here — the same coupling tests/deploy/runLogging.test.ts keeps between the
    // wrapper's log root and this hook's. A silent disagreement would mean the producer marks lines
    // nobody selects: an alert that looks fine and carries nothing.
    const hook = await readFile(REAL_SCRIPT_PATH, "utf8");
    const spelled = /^ALERT_MARKER="([^"]*)"$/m.exec(hook)?.[1];
    expect(spelled, "deploy/herald-notify-failure.sh no longer sets ALERT_MARKER=\"…\"").toBeDefined();
    expect(spelled).toBe(ALERT_MARKER);
  });

  it("is a prefix a scheduled command would not print by accident", () => {
    // The other three units pipe `claude -p` output through the same log. A marker they could emit
    // by chance would change their alerts, which is the one thing this change must not do.
    expect(ALERT_MARKER).toMatch(/^[A-Z_]+: $/);
  });
});

describe("marked lines reach the alert regardless of tail depth", () => {
  it("carries the line out of the journal when the tail has moved past it", () => {
    // Two systemd lines beyond what fits: at LOG_TAIL_LINES=5 the marked line is the 7th from the
    // end, well outside the window that used to be the only source of message content.
    const text = sentText(
      credsRun([
        "herald-creds.service: Main process exited, code=exited, status=1/FAILURE",
        "herald-creds.service: Failed with result 'exit-code'.",
        "Failed to start Mantle KR Herald credential liveness.",
        "herald-creds.service: Consumed 1.234s CPU time.",
      ]),
    );
    expect(text).toBeDefined();
    expect(text, `the alert did not name the dead credential:\n${text}`).toContain("live: google_auth");
    // Stripped, so the marker costs the message nothing.
    expect(text).not.toContain(ALERT_MARKER);
    // Directly under the header, where it is read first.
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: google_auth");
  });

  it("carries it out of the durable run log too, when the journal is empty", async () => {
    await seedRunLog(TEST_UNIT, credsRun(["herald-creds.service: Consumed 1.234s CPU time."]) + "\n");
    const text = sentText("");
    expect(text).toContain("live: google_auth");
    expect(text).not.toContain(ALERT_MARKER);
    // The run-log branch still points at the file rather than at journalctl.
    expect(text).toContain("tail -n 50 ");
  });

  it("shows it once, not twice, when the tail happens to include it", () => {
    // The marked line is second-from-last here, so it is inside the tail as well. It must appear in
    // the promoted position and be removed from the excerpt — never printed twice, and never once
    // with the raw marker still attached.
    const text = sentText(credsRun([]));
    expect(text!.match(/✗ FAILED: live: google_auth/g)).toHaveLength(1);
    expect(text).not.toContain(ALERT_MARKER);
  });

  it("bounds what it can add, so a log full of marked lines cannot grow the message", () => {
    const many = Array.from({ length: 40 }, (_, i) => `${ALERT_MARKER}${"x".repeat(80)}-${i}`);
    const text = sentText([...many, "=== herald-creds.service exited 1 ==="].join("\n"));
    expect(text).toBeDefined();
    // Three lines at most, and a character cap that actually binds well below that.
    const added = text!.split("\n").filter((l) => l.startsWith("x") || l.includes("(truncated)"));
    expect(added.length).toBeLessThanOrEqual(3);
    expect(text!.length).toBeLessThan(1200);
    expect(text).toContain("(truncated)");
  });
});

describe("purely additive — a unit that marks nothing is unaffected", () => {
  it("builds exactly the message it built before the mechanism existed", () => {
    // The legacy shape, written out. Any stray line, blank or prefix the marked-line block might
    // introduce for an unmarked unit fails this equality. (The byte-for-byte diff against the
    // pre-change script for all three other units was run out of band and recorded in the report;
    // this is the in-suite form of the same guarantee.)
    const journal = ["collect: 3 new", "Error: ECONNREFUSED", "=== exited 1 ==="].join("\n");
    const text = sentText(journal);
    expect(text).toBe(`⚠ ${TEST_UNIT} failed\n${journal}\n— journalctl --user -u ${TEST_UNIT} -n 50 --no-pager`);
  });

  it("still falls back to the plain notice when there is nothing anywhere", () => {
    const text = sentText("");
    expect(text).toContain("no journal lines captured, and no durable run log either");
  });
});
