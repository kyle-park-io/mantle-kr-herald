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
/** The invocation id this file's run-log fixtures are written under, and the one the systemctl stub
 *  reports as the unit's current one. The hook refuses any run log it cannot attribute to the run
 *  that just failed, so a fixture without a matching id is a file it will not read at all. */
const TEST_INVOCATION_ID = "1f2e3d4c5b6a79880123456789abcdef";

/**
 * systemctl stub. Honours `-p` and emits nothing for a name it does not recognise, the way the real
 * one does; defaults to a matching invocation id (so a seeded run log is usable) plus
 * `ExecMainCode=0`/`ExecMainStatus=0`, verbatim what a real `systemctl --user show` prints for a
 * unit it has never heard of. tests/deploy/notifyFailure.test.ts drives every branch of that lookup.
 *
 * Needed HERE because this file's TEST_UNIT is `herald-creds.service`, a unit that is genuinely
 * installed on the development box (measured: it reports ExecMainStatus=2 right now). Without the
 * stub, the byte-for-byte equality assertion below would compare against a header carrying whatever
 * that real unit last did, and would say something different again on CI. The marker mechanism is
 * what this file is about; the exit code must be a constant here, not a reading of the host.
 */
const SYSTEMCTL_STUB_LINES = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
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
  '[ "$want_status" = 1 ] && printf "ExecMainStatus=%s\\n" "${STUB_EXEC_MAIN_STATUS:-0}"',
  '[ "$want_code" = 1 ] && printf "ExecMainCode=%s\\n" "${STUB_EXEC_MAIN_CODE:-0}"',
  `[ "$want_invocation" = 1 ] && printf "InvocationID=%s\\n" "\${STUB_INVOCATION_ID-${TEST_INVOCATION_ID}}"`,
  "exit 0",
];
// Honours `-n`, like the real thing and like the (now fixed) stub in notifyFailure.test.ts. Without
// that, "the marked line is outside the tail" is a premise no test actually establishes.
const JOURNALCTL_STUB_LINES = [
  "#!/usr/bin/env bash",
  'n=""; prev=""',
  'for arg in "$@"; do [ "$prev" = "-n" ] && n="$arg"; prev="$arg"; done',
  'out="${STUB_JOURNAL_OUTPUT:-}"',
  'if [ -n "$n" ] && [ -n "$out" ]; then out="$(printf %s "$out" | tail -n "$n")"; fi',
  'printf %s "$out"',
  "exit 0",
];

let workDir: string;
let repoDir: string;
let stubDir: string;
let scriptPath: string;
/**
 * HERALD_LOG_DIR for the script under test, always a fresh per-test path — but, unlike
 * `tests/deploy/notifyFailure.test.ts`, never `mkdir`'d in `beforeEach` here. Since the script now
 * reads the run log FIRST (this task), a test that wants the JOURNAL branch (EXCERPT_SOURCE
 * "journal") must not seed a run log for TEST_UNIT: with nothing under this path, `ls` on the
 * per-unit directory finds no `*.log` file, RUN_LOG stays empty, and the script falls through to
 * `journalctl`. Every test below that sets only STUB_JOURNAL_OUTPUT (no `seedRunLog` call) is
 * exercising the journal branch for exactly this reason. Tests that call `seedRunLog` are
 * exercising the run-log branch instead, and say so in their own titles/comments.
 */
let logRoot: string;

async function writeExecutable(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  await chmod(path, 0o755);
}

/**
 * Writes a run log the way deploy/herald-run-logged.sh writes one — headed with the wrapper's own
 * `=== <unit> started … invocation <id> — <cmd> ===` line, because the hook refuses a file it cannot
 * attribute to the run that just failed. `invocation: null` writes the body bare, which is an
 * unverifiable file and therefore one the hook will not read.
 */
async function seedRunLog(unit: string, body: string, invocation: string | null = TEST_INVOCATION_ID): Promise<string> {
  const dir = join(logRoot, unit.replace(/\.service$/, ""));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "20260810T062300Z.log");
  const header = `=== ${unit} started 2026-08-10T06:23:00Z invocation ${invocation} — pnpm creds:check ===`;
  await writeFile(path, invocation === null ? body : `${header}\n${body}`, "utf8");
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
      // The user bus, so `systemctl --user` is able to work here the way it does under systemd —
      // its absence, not the assertions, used to be what kept the exit code out of these headers.
      // The stub above is what answers; these are here so nothing passes by a missing bus.
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
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
  await writeExecutable(join(stubDir, "systemctl"), SYSTEMCTL_STUB_LINES);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * The boundary deploy/herald-run-logged.sh writes before every run, INCLUDING the invocation id it
 * has carried since the hook started refusing run logs it cannot attribute to the failing run.
 *
 * The hook's scoping `awk` tests `index($0, marker) == 1` against the `=== <unit> started ` prefix
 * only, so today the id's absence here changed no result — which is exactly why it survived as a
 * fixture that no longer matched production. If anyone tightens that predicate to the full header,
 * a half-spelled fixture passes while the real wrapper's line stops matching, and the alert silently
 * loses its run scoping. Spelled in full so the two cannot diverge unnoticed.
 */
function startLine(
  stamp = "2026-08-10T06:23:00Z",
  cmd = "pnpm creds:check",
  invocation: string = TEST_INVOCATION_ID,
): string {
  return `=== ${TEST_UNIT} started ${stamp} invocation ${invocation} — ${cmd} ===`;
}

/** A report-shaped run, with the marked summary last, followed by however many trailing lines.
 *  `start: false` omits the wrapper's own header line, for a fixture that is written to a run log —
 *  `seedRunLog` heads those itself, with the invocation id the hook verifies. */
function credsRun(trailing: string[], { start = true }: { start?: boolean } = {}): string {
  return [
    ...(start ? [startLine()] : []),
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
    await seedRunLog(TEST_UNIT, credsRun(["herald-creds.service: Consumed 1.234s CPU time."], { start: false }) + "\n");
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
    // Six plain trailing lines, so the five-line tail contains no marked line of its own and this
    // measures only what the promotion adds.
    const many = Array.from({ length: 40 }, (_, i) => `${ALERT_MARKER}${"x".repeat(80)}-${i}`);
    const trailing = Array.from({ length: 6 }, (_, i) => `plain trailing line ${i}`);
    const text = sentText([startLine(), ...many, ...trailing].join("\n"));
    expect(text).toBeDefined();
    const added = text!.split("\n").filter((l) => l.startsWith("x") || /^x*-\d+…/.test(l));
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
    expect(text).toBe(
      `⚠ ${TEST_UNIT} 실패\n<pre>${journal}</pre>\n↳ journalctl --user -u ${TEST_UNIT} -n 50 --no-pager`,
    );
  });

  it("still falls back to the plain notice when there is nothing anywhere", () => {
    const text = sentText("");
    expect(text).toContain("실행 로그도 저널도 남지 않았습니다");
  });
});

/**
 * The regression the marker mechanism introduced and this describe block exists to keep out.
 *
 * `journalctl --user -u <unit>` is one continuous stream per unit, not one invocation. The five-line
 * tail was implicitly scoped to the current run; a 200-line window is not. A creds:check run is
 * eighteen lines, so roughly eleven previous daily runs fit inside it — and a run that exits 2 today
 * (a machine-configuration error naming no credential at all) headlined YESTERDAY's dead credential.
 *
 * These fixtures pad each run past LOG_TAIL_LINES on purpose. The five-line tail was never the buggy
 * part; the promoted line was. A fixture short enough for yesterday's output to fall inside today's
 * tail would be asserting about the wrong mechanism.
 */
describe("promoted lines come from this run, never a previous one", () => {
  const yesterday = [
    startLine("2026-08-09T06:23:00Z"),
    "Mantle KR Herald — credential liveness",
    "  ✗ live: google_auth            HTTP 401 invalid_grant",
    "6 ok · 0 warn · 1 fail",
    `${ALERT_MARKER}✗ FAILED: live: google_auth`,
    `=== ${TEST_UNIT} exited 1 at 2026-08-09T06:23:04Z ===`,
  ];
  /** Today: a configuration error. Exit 2 names no credential — the case that used to misreport. */
  const todayExitsTwo = [
    startLine("2026-08-10T06:23:00Z"),
    "Not an http(s) URL: mailto:ops@example.com — this command talks to a deployment over HTTP.",
    "Usage: pnpm creds:check <url>   (or set HERALD_DEPLOYMENT_ORIGIN)",
    "no report was printed",
    "nothing was asked of the deployment",
    `=== ${TEST_UNIT} exited 2 at 2026-08-10T06:23:00Z ===`,
  ];

  it("does not headline yesterday's dead credential when today's run named no credential", () => {
    const text = sentText([...yesterday, ...todayExitsTwo].join("\n"));
    expect(text).toBeDefined();
    expect(
      text,
      `today's run exited 2 and named nothing; the alert must not name a credential:\n${text}`,
    ).not.toContain("google_auth");
    // The real cause is still delivered, by the ordinary tail.
    expect(text).toContain("Not an http(s) URL");
  });

  it("still promotes when the marked line belongs to the run that is failing now", () => {
    // Note there is no exit line after it — this is the run in progress, which must not stop it
    // being scoped. The exit line is not what scopes anything; the start line is.
    const todayFails = [
      startLine("2026-08-10T06:23:00Z"),
      "Mantle KR Herald — credential liveness",
      "  ✗ live: lark                   HTTP 401",
      "  ✓ live: telegram               alive",
      "6 ok · 0 warn · 1 fail",
      `${ALERT_MARKER}✗ FAILED: live: lark`,
    ];
    const text = sentText([...yesterday, ...todayFails].join("\n"));
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: lark");
    expect(text).not.toContain("google_auth");
  });

  it("promotes nothing when this run's start line is not in the window at all", () => {
    // A run predating the wrapper's header. Guessing which run a marked line came from is what this
    // block refuses to do, so the promoted position carries the reason instead of a guess.
    const noStart = [...yesterday.slice(1), "later output 1", "later output 2", "later output 3"];
    const text = sentText(noStart.join("\n"));
    expect(text!.split("\n")[1]).toContain("belong to an earlier run");
    expect(text!.split("\n")[1]).not.toContain("✗ FAILED:");
    expect(text).toContain("later output 3");
  });

  it("does not scope the durable run log, which is one run per file by definition", async () => {
    // A run long enough that its own header falls OUT of the 200-line scan window. That is what
    // separates the two branches now: on the JOURNAL branch, no start line in the window means
    // nothing may be attributed to this run and nothing is promoted. A run log needs no such filter
    // — the file IS one run, proven by the invocation id in its header — and applying the journal's
    // filter to it would trade a correct message for an empty one.
    //
    // This used to be driven by a run log with no start line at all, which no longer distinguishes
    // anything: every usable run log is headed now, so a wrongly-applied filter would simply keep
    // everything after that header. Verified by mutation — with the old fixture, applying the
    // journal's scoping to this branch left the whole file green.
    const filler = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    await seedRunLog(
      TEST_UNIT,
      [...filler, `${ALERT_MARKER}✗ FAILED: live: google_auth`, "after", "the", "marked line"].join("\n") + "\n",
    );
    const text = sentText("");
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: google_auth");
    expect(text, "the run log is one run; it can never have outrun its own window").not.toContain(
      "longer than the",
    );
  });
});

describe("promote-or-keep, never promote-or-delete", () => {
  it("keeps marked lines it did not promote, instead of deleting them from the tail", () => {
    // Five marked lines, all inside the five-line tail. Three are promoted; the other two must not
    // vanish from a message the pre-marker script delivered in full.
    const marked = Array.from({ length: 5 }, (_, i) => `${ALERT_MARKER}✗ FAILED: credential-${i}`);
    const text = sentText([startLine(), ...marked].join("\n"));
    expect(text).toBeDefined();
    for (let i = 0; i < 5; i++) {
      expect(text, `credential-${i} vanished from the alert:\n${text}`).toContain(`credential-${i}`);
    }
    // Kept is not the same as duplicated, and no kept line carries the raw marker.
    expect(text!.match(/credential-4/g)).toHaveLength(1);
    expect(text).not.toContain(ALERT_MARKER);
  });

  it("still sends the promoted line when promotion took the whole of the run's own output", async () => {
    // A run whose only output is the marked line. After promote-or-keep the excerpt is reduced to
    // the wrapper's own boundary line and nothing else, and the message must still carry the
    // promoted line rather than falling through to "no lines captured" — and must carry it once.
    //
    // Narrower than it used to be, and deliberately so. This previously seeded a run log whose only
    // line was the marked one, leaving the excerpt EMPTY. That state is no longer reachable from
    // either source: a run log must be headed to be usable at all and the journal must carry a
    // start line to be scoped at all, so a boundary line always survives promotion. Asserting an
    // unreachable state would be asserting nothing.
    await seedRunLog(TEST_UNIT, `${ALERT_MARKER}✗ FAILED: live: google_auth\n`);
    const text = sentText("");
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: google_auth");
    expect(text!.match(/✗ FAILED: live: google_auth/g)).toHaveLength(1);
    expect(text).not.toContain(ALERT_MARKER);
    expect(text).not.toContain("실행 로그도 저널도 남지 않았습니다");
  });

  it("promotes a marked line that is indented, and does not leave the raw marker behind", () => {
    // A line at column > 0 used to be neither promoted nor stripped: the prefix reached the phone
    // and the credential was lost from the position that is meant to guarantee it.
    const text = sentText([startLine(), `    ${ALERT_MARKER}✗ FAILED: live: telegram`, "trailing"].join("\n"));
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: telegram");
    expect(text).not.toContain(ALERT_MARKER);
  });
});

describe("the scan window says when it filled", () => {
  it("says so when the window filled with this run's start line still inside it", () => {
    const before = Array.from({ length: 100 }, (_, i) => `older line ${i}`);
    const after = Array.from({ length: 150 }, (_, i) => `line ${i}`);
    const text = sentText([...before, startLine(), `${ALERT_MARKER}✗ FAILED: live: lark`, ...after].join("\n"));
    expect(text!.split("\n")[1]).toBe("✗ FAILED: live: lark");
    expect(text).toContain("scan window full");
  });

  it("says the run outran the window when the start line fell out of it", () => {
    const filler = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const text = sentText([startLine(), ...filler, `${ALERT_MARKER}✗ FAILED: live: lark`, "a", "b", "c"].join("\n"));
    expect(text).toContain("longer than the");
    expect(text!.split("\n")[1]).not.toContain("✗ FAILED:");
  });

  it("says nothing at all for a unit that marks no lines, however full the window", () => {
    // The byte-identical constraint: the other three units must not gain a line of any kind.
    const filler = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const text = sentText([startLine(), ...filler].join("\n"));
    expect(text).not.toContain("scan window");
    expect(text).not.toContain("earlier run");
    expect(text).not.toContain("longer than the");
  });
});
