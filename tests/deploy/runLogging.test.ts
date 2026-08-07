// tests/deploy/runLogging.test.ts
//
// journald on this box is not a log store, it is a roughly eight-minute window: it rotates the
// journal on every backwards clock step, and this machine's WSL2 host sync and systemd-timesyncd
// both step the clock constantly. A successful herald-watch run at 02:17 had zero recoverable lines
// by 03:30 the same morning. deploy/herald-run-logged.sh is the answer — it wraps each scheduled
// command, tees its output into a durable per-run file under ~/.herald/logs/, and hands the
// command's own exit status back to systemd unchanged.
//
// That last clause is the whole risk of this design, and the reason most of this file exists. Both
// scheduled units set `OnFailure=herald-notify-failure@%n.service`; a wrapper that swallows a
// non-zero exit does not lose a log line, it switches off the Telegram alert for a dead scheduler
// permanently and invisibly — the symptom of a broken failure alert is silence, and silence is also
// what success looks like. `cmd | tee log` reports *tee's* status, which is 0 whenever the file is
// writable, so the naive shape of this wrapper is exactly the shape that breaks it. The tests below
// run the real script against commands that exit 0, 1, 7 and 42 rather than reasoning about it.
//
// Follows tests/deploy/notifyFailure.test.ts's convention: the real script is executed for real
// against a temp directory (via HERALD_LOG_DIR), never a stub of it, so the pipeline, the pruning
// and the fallbacks are the ones production runs. The unit files are read as text, the convention
// the rest of tests/deploy/ uses.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../..");
const SCRIPT = resolve(repoRoot, "deploy/herald-run-logged.sh");
const NOTIFY_SCRIPT = resolve(repoRoot, "deploy/herald-notify-failure.sh");

/** The retained-run cap the script ships with, asserted behaviourally further down. */
const DEFAULT_KEEP_RUNS = 60;

const TEST_UNIT = "herald-watch.service";
/** The per-unit log directory name the script derives from that unit name. */
const TEST_UNIT_DIR = "herald-watch";

let workDir: string;
let logRoot: string;

/**
 * Runs the real wrapper with `unit` as $1 and `command` as the rest of the argv — exactly the shape
 * a unit's `ExecStart=` produces. `unit === undefined` omits the argument entirely, to exercise the
 * refusal path.
 */
function runWrapper(
  unit: string | undefined,
  command: string[],
  env: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  const argv = unit === undefined ? [SCRIPT, ...command] : [SCRIPT, unit, ...command];
  const result = spawnSync("bash", argv, {
    env: {
      // Minimal, like notifyFailure.test.ts's: the script needs date/mkdir/rm/tee, nothing else.
      PATH: "/usr/bin:/bin",
      HOME: workDir,
      HERALD_LOG_DIR: logRoot,
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A command spelled the way a unit spells one: an absolute interpreter plus its arguments. */
function shellCommand(script: string): string[] {
  return ["/bin/bash", "-c", script];
}

async function listRunLogs(unitDir: string = TEST_UNIT_DIR): Promise<string[]> {
  try {
    return (await readdir(join(logRoot, unitDir))).filter((n) => n.endsWith(".log")).sort();
  } catch {
    return [];
  }
}

/** The contents of the one run log under `unitDir`, failing if there is not exactly one. */
async function onlyRunLog(unitDir: string = TEST_UNIT_DIR): Promise<string> {
  const names = await listRunLogs(unitDir);
  expect(names, `expected exactly one run log under ${unitDir}`).toHaveLength(1);
  return readFile(join(logRoot, unitDir, names[0]), "utf8");
}

/**
 * The wrapped command's OWN output, with the wrapper's `=== … ===` header and footer stripped.
 *
 * Load-bearing, not tidiness. The header echoes the entire command line, so any marker a test looks
 * for in the output — `echo oops` — is also sitting in `=== … — /bin/bash -c echo oops >&2 ===`.
 * Asserted against the raw text, the stderr test below passed against a wrapper with `2>&1` deleted
 * outright, and so did most of the others: they were reading the wrapper's echo of the command
 * rather than the command's output. Found by mutating the script, not by reading the tests.
 */
function commandOutput(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^=== .* ===$/.test(line))
    .join("\n");
}

/** `onlyRunLog` with the framing stripped — what a test means when it says "the log contains X". */
async function onlyRunLogBody(unitDir: string = TEST_UNIT_DIR): Promise<string> {
  return commandOutput(await onlyRunLog(unitDir));
}

/** Seeds `count` past run logs whose names sort chronologically, oldest first. */
async function seedRunLogs(count: number): Promise<void> {
  const dir = join(logRoot, TEST_UNIT_DIR);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    await writeFile(join(dir, `20260101T${String(i).padStart(6, "0")}Z.log`), `seeded ${i}\n`, "utf8");
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "herald-run-logged-test-"));
  logRoot = join(workDir, "logs");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("deploy/herald-run-logged.sh — exit status", () => {
  it("exits 0 when the wrapped command exits 0", () => {
    expect(runWrapper(TEST_UNIT, shellCommand("echo ok")).status).toBe(0);
  });

  // The single most important assertion in this file. A `cmd | tee log` without `${PIPESTATUS[0]}`
  // reports tee's status — 0 — for every one of these, so this case is what stands between the repo
  // and a failure alert that silently never fires again. Several distinct codes rather than just 1,
  // because a wrapper that collapsed everything to a bare 1 would still fail the unit but would
  // erase the distinction `systemctl --user show -p ExecMainStatus` is read for: 1 is the CLI's own
  // failure, 127 is "pnpm was not on the unit's PATH", 143 is TimeoutStartSec= killing a wedged run.
  for (const code of [1, 7, 42]) {
    it(`propagates exit status ${code} unchanged, and still writes the run log`, async () => {
      const { status } = runWrapper(TEST_UNIT, shellCommand(`echo about-to-fail; exit ${code}`));
      expect(status).toBe(code);
      // Proves the status arrived through the tee'd path rather than the no-log fallback, which
      // would also report the right code — and would let this test pass while the feature that
      // makes it interesting does nothing at all.
      expect(await onlyRunLogBody()).toContain("about-to-fail");
    });
  }

  it("reports the command's status on the ordinary path where the log write succeeds", async () => {
    // Stated apart from the loop above because it names the exact hazard: tee succeeding is the
    // normal case, and the normal case is the one that swallows the status.
    expect(runWrapper(TEST_UNIT, shellCommand("exit 3")).status).toBe(3);
    expect(await listRunLogs()).toHaveLength(1);
  });

  it("reads the status out of ${PIPESTATUS[0]}, with nothing between it and the pipeline", () => {
    // Belt and braces, and the braces are what this pins. `set -o pipefail` at the top of the script
    // *also* makes a bare `$?` correct after that pipeline, so every behavioural test above passes
    // with the explicit read deleted — which makes it deletable, and it should not be: the two
    // guards fail to different edits (dropping `pipefail` from the `set` line, versus rewriting this
    // line), and only together do they survive both. The adjacency is asserted too, because
    // PIPESTATUS is clobbered by the next command to run: an `echo` slipped between the two lines
    // silently turns the status into the echo's.
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/^[ \t]*"\$@" 2>&1 \| tee -a "\$LOG_FILE"\n[ \t]*STATUS=\$\{PIPESTATUS\[0\]\}$/m);
    expect(script).toMatch(/^set -uo pipefail$/m);
  });

  it("records the exit status in the run log itself, so a past run can be judged", async () => {
    runWrapper(TEST_UNIT, shellCommand("exit 5"));
    expect(await onlyRunLog()).toMatch(/exited 5/);
  });
});

describe("deploy/herald-run-logged.sh — both sinks, never one instead of the other", () => {
  it("writes the command's output to the run log AND to its own stdout", async () => {
    // stdout is what systemd routes to journald. herald-notify-failure.sh reads the journal for its
    // excerpt, so a wrapper that captured output into a file and stopped forwarding it would trade
    // one sink for the other and break the alert's primary path.
    const { stdout } = runWrapper(TEST_UNIT, shellCommand("echo hello-from-the-command"));
    expect(commandOutput(stdout)).toContain("hello-from-the-command");
    expect(await onlyRunLogBody()).toContain("hello-from-the-command");
  });

  it("captures the command's stderr as well as its stdout", async () => {
    // The interesting half of a failed run is almost always on stderr — a stack trace, a pg error.
    const { stdout } = runWrapper(TEST_UNIT, shellCommand("echo oops >&2; exit 1"));
    expect(commandOutput(stdout)).toContain("oops");
    expect(await onlyRunLogBody()).toContain("oops");
  });

  it("puts the same bytes into the run log as into the journal", async () => {
    // The two sinks are kept identical on purpose. herald-notify-failure.sh reads the journal first
    // and the run log second, so an alert whose content depended on which source happened to answer
    // would be harder to read, not easier — and the header and footer, which carry the command line
    // and the exit status, belong in both rather than only in the file that outlives the journal.
    const { stdout } = runWrapper(TEST_UNIT, shellCommand("echo one; echo two >&2; exit 4"));
    expect(await onlyRunLog()).toBe(stdout);
    // Guards the assertion above against passing vacuously if both sides were somehow empty.
    expect(stdout).toContain("one");
    expect(stdout).toContain(TEST_UNIT);
  });

  it("names the unit and the command it ran in the log's own header", async () => {
    // What makes a run log answerable months later: which unit, and what it actually invoked —
    // whether `--yes` was present, for instance, is the difference between a reconcile that writes
    // and one that previews into a journal nobody is tailing.
    runWrapper(TEST_UNIT, shellCommand("echo hi"));
    const log = await onlyRunLog();
    expect(log).toContain(TEST_UNIT);
    expect(log).toContain("/bin/bash");
  });
});

describe("deploy/herald-run-logged.sh — where the logs live", () => {
  it("creates the log directory on a box where it has never existed", async () => {
    // The units must not fail merely because ~/.herald/logs is not there yet. The directory is
    // created by the script itself rather than by an ExecStartPre=, so there is no ordering to get
    // wrong, nothing extra to install, and the fresh-box case is the same code path as every other.
    logRoot = join(workDir, "never", "existed", "logs");
    expect(runWrapper(TEST_UNIT, shellCommand("echo fresh-box")).status).toBe(0);
    expect(await onlyRunLogBody()).toContain("fresh-box");
  });

  it("keeps each unit's runs in its own directory", async () => {
    runWrapper("herald-watch.service", shellCommand("echo from-watch"));
    runWrapper("herald-x-reconcile.service", shellCommand("echo from-reconcile"));
    expect(await onlyRunLogBody("herald-watch")).toContain("from-watch");
    expect(await onlyRunLogBody("herald-x-reconcile")).toContain("from-reconcile");
    // Interleaving the two would make "what did last night's reconcile do?" a grep rather than a
    // read, and the two units fire on different cadences into the same blind spot.
    expect(await onlyRunLogBody("herald-watch")).not.toContain("from-reconcile");
  });

  it("defaults to ~/.herald/logs — the same tier as ~/.herald/app and ~/.herald/output", () => {
    // Asserted as text because the default is deliberately never exercised by these tests: firing
    // it for real would write into Kyle's live scheduler logs. HERALD_LOG_DIR exists so the tests
    // can run the real script without that; nothing in production sets it.
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('LOG_ROOT="${HERALD_LOG_DIR:-${HOME:-}/.herald/logs}"');
    // Never inside either checkout: a log under the deploy checkout is wiped by herald-deploy.sh's
    // `git reset --hard`, and one under the development tree turns up in someone's `git status`.
    expect(script).not.toContain(repoRoot);
  });
});

describe("deploy/herald-run-logged.sh — bounded growth", () => {
  it("keeps at most the configured number of runs, deleting the oldest first", async () => {
    await seedRunLogs(10);
    const { status } = runWrapper(TEST_UNIT, shellCommand("echo newest"), { HERALD_LOG_KEEP_RUNS: "3" });
    expect(status).toBe(0);
    const remaining = await listRunLogs();
    expect(remaining).toHaveLength(3);
    // The two newest seeded runs plus this one — oldest-first deletion, not newest-first.
    expect(remaining.slice(0, 2)).toEqual(["20260101T000009Z.log", "20260101T000010Z.log"]);
    expect(await readFile(join(logRoot, TEST_UNIT_DIR, remaining[2]), "utf8")).toContain("newest");
  });

  it("never prunes the run it is about to write, even at a cap of one", async () => {
    // Pruning happens before the new file is opened precisely so the current run can never be a
    // candidate. An off-by-one here deletes the log of the run someone is watching.
    await seedRunLogs(4);
    runWrapper(TEST_UNIT, shellCommand("echo survivor"), { HERALD_LOG_KEEP_RUNS: "1" });
    const remaining = await listRunLogs();
    expect(remaining).toHaveLength(1);
    expect(await readFile(join(logRoot, TEST_UNIT_DIR, remaining[0]), "utf8")).toContain("survivor");
  });

  it(`enforces ${DEFAULT_KEEP_RUNS} retained runs by default`, async () => {
    // Behavioural rather than a grep for the number: this is the cap production actually runs
    // under. Sixty is five days of herald-watch at its two-hour cadence, fifteen of
    // herald-x-reconcile at its six-hour one.
    await seedRunLogs(DEFAULT_KEEP_RUNS + 5);
    runWrapper(TEST_UNIT, shellCommand("echo capped"));
    expect(await listRunLogs()).toHaveLength(DEFAULT_KEEP_RUNS);
  });

  it("falls back to the default cap, loudly, rather than letting a garbage override disable pruning", async () => {
    // An unparseable cap that silently meant "keep everything" would turn the bound into a
    // suggestion, and the consequence would surface as a full disk months later.
    await seedRunLogs(DEFAULT_KEEP_RUNS + 5);
    const { status, stderr } = runWrapper(TEST_UNIT, shellCommand("echo capped"), {
      HERALD_LOG_KEEP_RUNS: "lots",
    });
    expect(status).toBe(0);
    expect(stderr).toContain("not a positive integer");
    expect(await listRunLogs()).toHaveLength(DEFAULT_KEEP_RUNS);
  });
});

describe("deploy/herald-run-logged.sh — degrades instead of breaking the run", () => {
  it("still runs the command, and still propagates its status, when the log cannot be written", async () => {
    // A logging wrapper that can break the thing it logs is worse than no wrapper: the scheduled
    // work is the point, the log is instrumentation. Blocked with a regular file where a directory
    // component has to be, so this still holds if the suite ever runs as root (a chmod would not).
    const blocker = join(workDir, "blocker");
    await writeFile(blocker, "not a directory\n", "utf8");
    logRoot = join(blocker, "logs");

    const ok = runWrapper(TEST_UNIT, shellCommand("echo still-ran"));
    expect(ok.status).toBe(0);
    expect(commandOutput(ok.stdout)).toContain("still-ran");
    expect(ok.stderr).toContain("without a durable run log");

    expect(runWrapper(TEST_UNIT, shellCommand("exit 9")).status).toBe(9);
  });

  it("refuses, non-zero, when no unit name is given", () => {
    // Same posture as herald-notify-failure.sh's own argument check: a missing %n is a wiring
    // mistake in the caller, and it must surface as a failed unit — which, for these callers, is
    // also what fires the Telegram alert — rather than being guessed at.
    const { status, stderr } = runWrapper(undefined, []);
    expect(status).not.toBe(0);
    expect(stderr).toContain("no unit name");
  });

  it("refuses, non-zero, when a unit name is given but no command follows it", () => {
    const { status, stderr } = runWrapper(TEST_UNIT, []);
    expect(status).not.toBe(0);
    expect(stderr).toContain("no command");
  });

  it("is committed executable, since systemd runs it directly from the deploy checkout", () => {
    // herald-deploy.sh installs by `git reset --hard`, so the mode git records is the mode
    // production gets. A wrapper committed without +x makes both scheduled units fail to start —
    // and the OnFailure= hook would then fire on every single fire, forever.
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

describe("the scheduled units run through the wrapper", () => {
  const UNITS = [
    { path: "deploy/herald-watch.service", command: "pnpm watch" },
    { path: "deploy/herald-x-reconcile.service", command: "pnpm x:reconcile --yes" },
    { path: "deploy/herald-convert.service", command: "pnpm convert:tick" },
  ] as const;

  for (const { path, command } of UNITS) {
    it(`${path} wraps its command, from the deploy checkout, passing its own unit name`, () => {
      const unit = readFileSync(resolve(repoRoot, path), "utf8");
      const execStart = /^ExecStart=(.+)$/m.exec(unit)?.[1]?.trim();
      // `%h/.herald/app/...` for the same reason herald-notify-failure@.service uses it: production
      // must not run whatever happens to be checked out in the tree someone edits. `%n` is what
      // keys the per-unit log directory and what herald-notify-failure.sh looks its fallback up
      // under, so the two agree without either hardcoding a list of units.
      expect(execStart).toMatch(/^%h\/\.herald\/app\/deploy\/herald-run-logged\.sh %n \/\S*pnpm /);
      expect(execStart?.includes(repoRoot)).toBe(false);
    });

    it(`${path} still runs exactly the command it used to`, () => {
      // The wrapper is transparent by construction; this is what keeps it that way. Losing `--yes`,
      // or the `watch` subcommand, while rewriting this line is a one-token mistake with a silent
      // outcome — see xReconcileTiming.test.ts's own note on why --yes is asserted at all.
      const unit = readFileSync(resolve(repoRoot, path), "utf8");
      const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(unit).toMatch(new RegExp(`^ExecStart=.*${escaped}$`, "m"));
    });
  }
});

describe("the wrapper and the failure hook resolve the same log root", () => {
  it("spells the log root identically in both scripts", () => {
    // Two files, one decision — the same coupling tests/deploy/workingDirectory.test.ts pins
    // between the units' WorkingDirectory= and herald-deploy.sh's APP_DIR. If these drift, the
    // wrapper writes somewhere the failure hook never looks, and the fallback silently stops
    // finding anything while every test that exercises the two separately keeps passing.
    const EXPRESSION = '"${HERALD_LOG_DIR:-${HOME:-}/.herald/logs}"';
    expect(readFileSync(SCRIPT, "utf8")).toContain(EXPRESSION);
    expect(readFileSync(NOTIFY_SCRIPT, "utf8")).toContain(EXPRESSION);
  });

  it("derives the per-unit directory the same way in both scripts", () => {
    // `${UNIT%.service}` in both. A wrapper writing under `herald-watch` while the hook reads
    // `herald-watch.service` is the same drift one level down, and just as silent.
    const EXPRESSION = "${UNIT%.service}";
    expect(readFileSync(SCRIPT, "utf8")).toContain(EXPRESSION);
    expect(readFileSync(NOTIFY_SCRIPT, "utf8")).toContain(EXPRESSION);
  });
});
