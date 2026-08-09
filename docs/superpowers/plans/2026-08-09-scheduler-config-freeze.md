# Scheduler Config Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scheduled units' configuration a snapshot taken at deploy time instead of a symlink into the development checkout, and show — by name, never by value — what each deploy changes.

**Architecture:** A pure diff module (`src/deploy/configFreeze.ts`) alongside the existing `requirements.ts`/`smokeChecks.ts`, a CLI that does the I/O and owns the gate (`src/cli/deploy-freeze.ts`), and two call sites in `deploy/herald-deploy.sh` — `--check` before anything destructive, `--apply` where the symlinking used to be.

**Tech Stack:** TypeScript (ESM), tsx, Vitest, bash, git plumbing (`check-ignore`).

**Spec:** `docs/superpowers/specs/2026-08-09-scheduler-config-freeze-design.md`

## Global Constraints

- **`node_modules` is not installed on this machine** (2026-08-09 WSL reset). Run `pnpm install` before Task 1 or every test step fails for the wrong reason.
- **git identity is also missing.** Commit with `git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' commit …` or restore `~/.gitconfig` first.
- **Relative imports carry no file extension.** The repo has ~1015 such imports and `pnpm build:api` bundles around it. Match the surrounding files.
- **CLI output is English.** Korean stays for the dashboard and `docs/ko/`. This is stated in `src/deploy/requirements.ts:11-12`.
- **Never print an environment value.** Names only, everywhere — output, errors, test fixtures that get echoed.
- **Work on branch `design/scheduler-config-freeze`**, which already holds the spec commit `f696798`.
- Existing test conventions in `tests/deploy/`: run the real script/CLI against temp directories (`runLogging.test.ts`, `notifyFailure.test.ts`), and read unit/script files as text for wiring assertions (`workingDirectory.test.ts`).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/deploy/configFreeze.ts` (create) | Pure functions: parse an env file the way Node does, diff two name→value maps, format a name-only diff. No I/O. |
| `src/cli/deploy-freeze.ts` (create) | All I/O and the gate: read both trees, enumerate git-ignored steering files, print, exit 2 / copy. |
| `package.json` (modify) | Register `deploy:freeze`, without `--env-file-if-exists`. |
| `deploy/herald-deploy.sh` (modify) | Call `--check` at step 0, `--apply` at step 3; delete `link_ignored_config` and the `.env` symlink. |
| `tests/deploy/configFreeze.test.ts` (create) | The pure functions. |
| `tests/deploy/deployFreeze.test.ts` (create) | The real CLI against temp git repos. |
| `tests/deploy/heraldDeploy.test.ts` (create) | Script text: ordering and the absence of `ln -sfn`. |
| `docs/ko/deploy.md`, `docs/ko/team-runbook.md` (modify) | Both currently describe the symlink behaviour. |

---

### Task 1: `parseEnv` — model what Node actually loads

The parser's only job is to make the value comparison in Task 2 agree with what the scheduler will really see. Its rules were measured on Node v24.19.0 rather than assumed; the test below is those measurements.

**Files:**
- Create: `src/deploy/configFreeze.ts`
- Test: `tests/deploy/configFreeze.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseEnv(text: string): Map<string, string>`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/configFreeze.test.ts`:

```ts
// tests/deploy/configFreeze.test.ts
//
// The parser exists to make the diff agree with what the scheduler actually sees, so its rules are
// Node's rules, measured on Node v24.19.0 rather than assumed:
//
//   PLAIN=hello            => "hello"
//   DQ="double quoted"     => "double quoted"     (quotes stripped)
//   SQ='single quoted'     => "single quoted"
//   export EXPORTED=yes    => "yes"               (export prefix accepted)
//   SPACED = spaced        => "spaced"            (whitespace around = trimmed)
//   EMPTY=                 => ""
//   HASH=val#notcomment    => "val"               (unquoted value truncated at #)
//   DUP=first / DUP=second => "second"            (last duplicate wins)
//
// A parser that disagrees with any of these reports a variable as changed when the scheduler would
// read the same value, or — worse — as unchanged when it would not.
import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/deploy/configFreeze";

describe("parseEnv", () => {
  it("reads a plain assignment", () => {
    expect(parseEnv("PLAIN=hello").get("PLAIN")).toBe("hello");
  });

  it("strips double and single quotes", () => {
    const env = parseEnv(`DQ="double quoted"\nSQ='single quoted'`);
    expect(env.get("DQ")).toBe("double quoted");
    expect(env.get("SQ")).toBe("single quoted");
  });

  it("accepts an export prefix", () => {
    expect(parseEnv("export EXPORTED=yes").get("EXPORTED")).toBe("yes");
  });

  it("trims whitespace around the equals sign", () => {
    expect(parseEnv("SPACED = spaced").get("SPACED")).toBe("spaced");
  });

  it("keeps an empty value as an empty string, not absent", () => {
    const env = parseEnv("EMPTY=");
    expect(env.has("EMPTY")).toBe(true);
    expect(env.get("EMPTY")).toBe("");
  });

  it("truncates an unquoted value at an inline #", () => {
    expect(parseEnv("HASH=val#notcomment").get("HASH")).toBe("val");
  });

  it("keeps a # inside a quoted value", () => {
    expect(parseEnv(`HASH="val#kept"`).get("HASH")).toBe("val#kept");
  });

  it("lets the last duplicate win, as Node does", () => {
    expect(parseEnv("DUP=first\nDUP=second").get("DUP")).toBe("second");
  });

  it("skips comments and blank lines", () => {
    expect([...parseEnv("# comment\n\n  \nA=1").keys()]).toEqual(["A"]);
  });

  it("ignores a line that is not an assignment", () => {
    expect([...parseEnv("garbage line\nA=1").keys()]).toEqual(["A"]);
  });

  it("handles CRLF line endings", () => {
    expect([...parseEnv("A=1\r\nB=2").keys()]).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/configFreeze.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/deploy/configFreeze"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/deploy/configFreeze.ts`:

```ts
/**
 * Freezing the scheduler's configuration at deploy time means answering one question — did this
 * variable change? — and answering it the way the scheduler would. These functions therefore model
 * Node's own `--env-file` parsing (measured, see `tests/deploy/configFreeze.test.ts`) rather than a
 * generic dotenv dialect, and they are pure: every file read lives in `src/cli/deploy-freeze.ts`,
 * the same split `requirements.ts` and `smokeChecks.ts` already use.
 */

/** `export FOO=`, `FOO =`, `FOO=` — the key, and everything after the first `=`. */
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * A later duplicate overwrites an earlier one because Node does the same. Non-assignment lines are
 * skipped rather than rejected: this parser reads a file that already booted the scheduler, so
 * refusing it here would fail a deploy over a line Node is perfectly happy with.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    out.set(match[1], readValue(match[2]));
  }
  return out;
}

/** Quoted: taken literally, `#` included. Unquoted: trimmed and cut at the first `#`. */
function readValue(rest: string): string {
  const value = rest.trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/configFreeze.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/configFreeze.ts tests/deploy/configFreeze.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): parse env files the way Node's --env-file does"
```

---

### Task 2: The diff and its formatter — names out, values never

**Files:**
- Modify: `src/deploy/configFreeze.ts`
- Test: `tests/deploy/configFreeze.test.ts`

**Interfaces:**
- Consumes: `parseEnv` from Task 1.
- Produces:
  - `interface NameDiff { added: string[]; changed: string[]; removed: string[] }`
  - `diffEnv(previous: string | undefined, next: string): NameDiff`
  - `diffFiles(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): NameDiff`
  - `isEmptyDiff(diff: NameDiff): boolean`
  - `formatFreezeDiff(label: string, diff: NameDiff): string`

- [ ] **Step 1: Write the failing test**

Append to `tests/deploy/configFreeze.test.ts`:

```ts
import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff } from "../../src/deploy/configFreeze";

describe("diffEnv", () => {
  it("classifies added, changed and removed by name", () => {
    const diff = diffEnv("KEPT=same\nMOVED=before\nGONE=x", "KEPT=same\nMOVED=after\nFRESH=y");
    expect(diff).toEqual({ added: ["FRESH"], changed: ["MOVED"], removed: ["GONE"] });
  });

  it("treats an absent previous snapshot as everything added", () => {
    expect(diffEnv(undefined, "A=1\nB=2")).toEqual({ added: ["A", "B"], changed: [], removed: [] });
  });

  it("sorts each list so deploy output is stable", () => {
    expect(diffEnv("", "Z=1\nA=1\nM=1").added).toEqual(["A", "M", "Z"]);
  });

  it("sees no change when only formatting differs", () => {
    // Same value to Node, so the scheduler reads the same thing — reporting it would train the
    // operator to skim the diff.
    expect(isEmptyDiff(diffEnv(`A=hello`, `export A = "hello"`))).toBe(true);
  });
});

describe("diffFiles", () => {
  it("classifies steering files by content hash", () => {
    const before = new Map([["glossary.json", "h1"], ["dropped.md", "h2"]]);
    const after = new Map([["glossary.json", "h9"], ["added.md", "h3"]]);
    expect(diffFiles(before, after)).toEqual({
      added: ["added.md"], changed: ["glossary.json"], removed: ["dropped.md"],
    });
  });
});

describe("formatFreezeDiff", () => {
  // The load-bearing test of this file. A diff printed at deploy time is the one place where both
  // the old and the new value of every credential are in memory at once.
  it("never puts a value in its output", () => {
    const secret = "sk-live-51H8ZqABCDEFGHIJKLMNOP";
    const other = "postgres://user:hunter2@db.example.com:5432/herald";
    const out = formatFreezeDiff(
      "env",
      diffEnv(`TYPEFULLY_API_KEY=${secret}\nDATABASE_URL=old`, `TYPEFULLY_API_KEY=rotated\nDATABASE_URL=${other}`),
    );
    expect(out).not.toContain(secret);
    expect(out).not.toContain(other);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("TYPEFULLY_API_KEY");
    expect(out).toContain("DATABASE_URL");
  });

  it("marks each class with its own sigil", () => {
    const out = formatFreezeDiff("env", { added: ["NEW"], changed: ["MOVED"], removed: ["OLD"] });
    expect(out).toContain("+ NEW");
    expect(out).toContain("~ MOVED");
    expect(out).toContain("- OLD");
  });

  it("says so plainly when nothing moved", () => {
    expect(formatFreezeDiff("env", { added: [], changed: [], removed: [] })).toBe("  env: unchanged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/configFreeze.test.ts`
Expected: FAIL — `diffEnv is not a function` (and the other three exports).

- [ ] **Step 3: Write minimal implementation**

Append to `src/deploy/configFreeze.ts`:

```ts
/**
 * Names only. Both halves of every value are in memory when a diff is computed, and none of them
 * leave this shape — the deploy prints what it returns.
 */
export interface NameDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** `previous` is undefined on the first freeze, and when the old path was still a symlink. */
export function diffEnv(previous: string | undefined, next: string): NameDiff {
  return diffMaps(parseEnv(previous ?? ""), parseEnv(next));
}

/** Steering files: the map is path → content hash, so the same shape serves both diffs. */
export function diffFiles(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): NameDiff {
  return diffMaps(previous, next);
}

function diffMaps(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): NameDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [name, value] of next) {
    if (!previous.has(name)) added.push(name);
    else if (previous.get(name) !== value) changed.push(name);
  }
  for (const name of previous.keys()) if (!next.has(name)) removed.push(name);
  // Sorted so two deploys that change the same things print the same lines.
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

export function isEmptyDiff(diff: NameDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0;
}

/** Indented to sit under `herald-deploy.sh`'s existing `  code: …` / `  deps: …` lines. */
export function formatFreezeDiff(label: string, diff: NameDiff): string {
  if (isEmptyDiff(diff)) return `  ${label}: unchanged`;
  const lines = [`  ${label}:`];
  for (const name of diff.added) lines.push(`    + ${name}`);
  for (const name of diff.changed) lines.push(`    ~ ${name}`);
  for (const name of diff.removed) lines.push(`    - ${name}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/configFreeze.test.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/configFreeze.ts tests/deploy/configFreeze.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): diff two config snapshots by name, never by value"
```

---

### Task 3: `deploy:freeze --check` — the gate

Read-only. Prints both diffs and decides whether the deploy may continue.

**Files:**
- Create: `src/cli/deploy-freeze.ts`
- Modify: `package.json` (scripts)
- Test: `tests/deploy/deployFreeze.test.ts`

**Interfaces:**
- Consumes: `diffEnv`, `diffFiles`, `isEmptyDiff`, `formatFreezeDiff`, `NameDiff` from Task 2.
- Produces: the CLI contract every later task depends on —
  - `pnpm deploy:freeze --check --dev <dir> --app <dir> [--yes]`
  - exit `0` nothing changed, or changed with `--yes`; exit `2` changed without `--yes`; exit `1` usage error or missing `<dev>/.env`
  - exported for Task 4: `STEERING_DIRS: readonly string[]`, `ignoredFilesIn(devDir: string, rel: string): string[]`, `readSnapshot(dir: string): { env: string | undefined; steering: Map<string, string> }`

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/deployFreeze.test.ts`:

```ts
// tests/deploy/deployFreeze.test.ts
//
// Follows tests/deploy/runLogging.test.ts: the real CLI is executed against temp directories, never
// a stub, so the git plumbing that derives the steering file list is the one production runs. Both
// temp trees are real git repos with the repo's own ignore rules, because `git check-ignore` is how
// the list is derived and a fake would not exercise it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../..");

let dev = "";
let app = "";

/** A git repo whose .gitignore matches the real one for the directories the freeze touches. */
async function makeRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  spawnSync("git", ["-C", dir, "init", "--quiet"]);
  await writeFile(join(dir, ".gitignore"), [
    ".env*", "!.env.example",
    "translation/*", "!translation/*.example.json",
    "conversion/*", "!conversion/*.example.json",
    "keys/*", "!keys/README.md",
    "",
  ].join("\n"));
  for (const rel of ["translation", "conversion", "keys"]) await mkdir(join(dir, rel));
  return dir;
}

function freeze(...args: string[]) {
  return spawnSync("pnpm", ["deploy:freeze", ...args], { cwd: repoRoot, encoding: "utf8" });
}

beforeEach(async () => {
  dev = await makeRepo("freeze-dev-");
  app = await makeRepo("freeze-app-");
});

afterEach(async () => {
  await rm(dev, { recursive: true, force: true });
  await rm(app, { recursive: true, force: true });
});

describe("deploy:freeze --check", () => {
  it("refuses when the development .env is missing", async () => {
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain(".env");
  });

  it("reports every name as added on the first freeze, and gates on it", async () => {
    await writeFile(join(dev, ".env"), "TELEGRAM_BOT_TOKEN=secret-token-value\nX_PREMIUM=true\n");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ TELEGRAM_BOT_TOKEN");
    expect(res.stdout).toContain("+ X_PREMIUM");
    expect(res.stdout).not.toContain("secret-token-value");
  });

  it("passes with --yes", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    expect(freeze("--check", "--dev", dev, "--app", app, "--yes").status).toBe(0);
  });

  it("passes without --yes when nothing changed", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("unchanged");
  });

  it("counts an existing symlink as no snapshot at all", async () => {
    // Migration from the old layout: reading through the link would compare the development .env
    // with itself and report "unchanged" for what is in fact the very first freeze.
    await writeFile(join(dev, ".env"), "A=1\n");
    spawnSync("ln", ["-sfn", join(dev, ".env"), join(app, ".env")]);
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ A");
  });

  it("diffs steering files and ignores the committed examples", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "glossary.json"), "{}");
    await writeFile(join(dev, "translation", "tm.example.json"), "{}");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ translation/glossary.json");
    expect(res.stdout).not.toContain("tm.example.json");
  });

  it("changes nothing on disk", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    freeze("--check", "--dev", dev, "--app", app, "--yes");
    const res = spawnSync("test", ["-e", join(app, ".env")]);
    expect(res.status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/deployFreeze.test.ts`
Expected: FAIL — every case, because `pnpm deploy:freeze` is not a script yet (`ERR_PNPM_NO_SCRIPT`).

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/deploy-freeze.ts`:

```ts
/**
 * Moves the deploy checkout's configuration to match the development checkout's, visibly.
 *
 * Registered without `--env-file-if-exists`, alongside `auth:hash` and `config:init`: this command
 * does not read configuration, it moves it — and loading the development `.env` into its own
 * process would be a way to leak one into an error message.
 *
 * Two phases so `deploy/herald-deploy.sh` can gate before it does anything destructive. `--check`
 * is read-only and decides; `--apply` writes. Splitting them is what keeps a refused config change
 * from leaving the deploy checkout's code already moved to origin/main — that script's header calls
 * a half-finished deploy worse than none.
 */
import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff, type NameDiff } from "../deploy/configFreeze";

/** The same three the old `link_ignored_config` walked, in the same order. */
export const STEERING_DIRS = ["translation", "conversion", "keys"] as const;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/**
 * Derived, never hardcoded: any git-ignored file in the development checkout's steering directory
 * is config, and a steering file added later needs no edit here. `check-ignore` exits 1 when it
 * matches nothing, which is not an error — it means the directory holds only committed examples.
 */
export function ignoredFilesIn(devDir: string, rel: string): string[] {
  const dir = join(devDir, rel);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  if (names.length === 0) return [];
  const res = spawnSync("git", ["-C", devDir, "check-ignore", ...names.map((n) => join(dir, n))], {
    encoding: "utf8",
  });
  const ignored = new Set(res.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  return names.filter((n) => ignored.has(join(dir, n))).sort();
}

export interface Snapshot {
  env: string | undefined;
  steering: Map<string, string>;
}

/**
 * `lstat` and not `stat`: until the first freeze, `<app>/.env` is a symlink into the development
 * checkout, and following it would diff that file against itself and report "unchanged" for what is
 * actually the first snapshot ever taken.
 */
export function readSnapshot(dir: string): Snapshot {
  const envPath = join(dir, ".env");
  const isRealFile = existsSync(envPath) && lstatSync(envPath).isFile();
  const steering = new Map<string, string>();
  for (const rel of STEERING_DIRS) {
    for (const name of ignoredFilesIn(dir, rel)) {
      steering.set(`${rel}/${name}`, createHash("sha256").update(readFileSync(join(dir, rel, name))).digest("hex"));
    }
  }
  return { env: isRealFile ? readFileSync(envPath, "utf8") : undefined, steering };
}

function main(): void {
  const devDir = option("dev");
  const appDir = option("app");
  if (!devDir || !appDir) fail("Usage: deploy:freeze --check|--apply --dev <dir> --app <dir> [--yes]", 1);
  if (!existsSync(join(devDir, ".env"))) {
    fail(`No .env in the development checkout (${devDir}). Production configuration is copied from it — restore it before deploying.`, 1);
  }

  const next = readSnapshot(devDir);
  const previous = readSnapshot(appDir);
  const envDiff: NameDiff = diffEnv(previous.env, next.env ?? "");
  const steeringDiff: NameDiff = diffFiles(previous.steering, next.steering);

  console.log(formatFreezeDiff("env", envDiff));
  console.log(formatFreezeDiff("steering", steeringDiff));

  if (flag("check")) {
    if (isEmptyDiff(envDiff) && isEmptyDiff(steeringDiff)) process.exit(0);
    if (flag("yes")) process.exit(0);
    fail("  config: changes above are not applied. Re-run with --yes once they are what you intend.", 2);
  }

  fail("Nothing to do: pass --check or --apply.", 1);
}

main();
```

Add to `package.json` `scripts`, immediately after `"deploy:smoke"`:

```json
    "deploy:freeze": "tsx src/cli/deploy-freeze.ts",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/deployFreeze.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy-freeze.ts package.json tests/deploy/deployFreeze.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): gate the deploy on a name-only config diff"
```

---

### Task 4: `deploy:freeze --apply` — take the snapshot

**Files:**
- Modify: `src/cli/deploy-freeze.ts`
- Test: `tests/deploy/deployFreeze.test.ts`

**Interfaces:**
- Consumes: `STEERING_DIRS`, `ignoredFilesIn`, `readSnapshot` from Task 3.
- Produces: `--apply` — writes `<app>/.env` mode `0600`, writes each steering file, removes git-ignored files in `<app>` that no longer exist in `<dev>`, exits `0`.

- [ ] **Step 1: Write the failing test**

Append to `tests/deploy/deployFreeze.test.ts`:

```ts
import { statSync, readFileSync, existsSync } from "node:fs";

describe("deploy:freeze --apply", () => {
  it("writes the env file with mode 600", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);
    expect(readFileSync(join(app, ".env"), "utf8")).toBe("A=1\n");
    expect(statSync(join(app, ".env")).mode & 0o777).toBe(0o600);
  });

  it("replaces a symlink left by the old layout with a real file", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    spawnSync("ln", ["-sfn", join(dev, ".env"), join(app, ".env")]);
    freeze("--apply", "--dev", dev, "--app", app);
    expect(statSync(join(app, ".env")).isFile()).toBe(true);
    expect(existsSync(join(app, ".env"))).toBe(true);
    // The development copy must survive: rename replaces the link, not its target.
    expect(readFileSync(join(dev, ".env"), "utf8")).toBe("A=1\n");
  });

  it("copies steering files and gives keys/ mode 600", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "glossary.json"), `{"a":1}`);
    await writeFile(join(dev, "keys", "mantle-sa.json"), `{"private_key":"x"}`);
    freeze("--apply", "--dev", dev, "--app", app);
    expect(readFileSync(join(app, "translation", "glossary.json"), "utf8")).toBe(`{"a":1}`);
    expect(statSync(join(app, "keys", "mantle-sa.json")).mode & 0o777).toBe(0o600);
  });

  it("removes a steering file that no longer exists in the development checkout", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, "translation", "glossary.json"), "{}");
    freeze("--apply", "--dev", dev, "--app", app);
    expect(existsSync(join(app, "translation", "glossary.json"))).toBe(false);
  });

  it("leaves committed example files alone", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, "translation", "tm.example.json"), "{}");
    freeze("--apply", "--dev", dev, "--app", app);
    expect(existsSync(join(app, "translation", "tm.example.json"))).toBe(true);
  });

  it("is idempotent", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    freeze("--apply", "--dev", dev, "--app", app);
    const second = freeze("--apply", "--dev", dev, "--app", app);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("unchanged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/deployFreeze.test.ts -t "apply"`
Expected: FAIL — exit 1 with `Nothing to do: pass --check or --apply.`

- [ ] **Step 3: Write minimal implementation**

In `src/cli/deploy-freeze.ts`, extend the imports and add the writer, then replace the final `fail(...)` line of `main()`.

Imports become:

```ts
import { readFileSync, readdirSync, existsSync, lstatSync, writeFileSync, chmodSync, renameSync, rmSync, mkdirSync } from "node:fs";
```

Add above `main()`:

```ts
/**
 * Written to a temp name in the destination directory and renamed, so an interrupted deploy leaves
 * each file either wholly old or wholly new. `chmod` before the rename, not after: the window where
 * a credential exists at the wrong mode should not exist at all.
 */
function writeFrozen(dest: string, data: Buffer, mode: number): void {
  const tmp = `${dest}.freeze-${process.pid}`;
  writeFileSync(tmp, data);
  chmodSync(tmp, mode);
  renameSync(tmp, dest);
}

/** `.env` and the service-account key are secrets; a glossary is a team document. */
function modeFor(relPath: string): number {
  return relPath === ".env" || relPath.startsWith("keys/") ? 0o600 : 0o644;
}

function apply(devDir: string, appDir: string): void {
  writeFrozen(join(appDir, ".env"), readFileSync(join(devDir, ".env")), modeFor(".env"));
  console.log("  freeze: .env");

  for (const rel of STEERING_DIRS) {
    const wanted = ignoredFilesIn(devDir, rel);
    if (wanted.length > 0) mkdirSync(join(appDir, rel), { recursive: true });
    for (const name of wanted) {
      writeFrozen(join(appDir, rel, name), readFileSync(join(devDir, rel, name)), modeFor(`${rel}/${name}`));
      console.log(`  freeze: ${rel}/${name}`);
    }
    // Only ever the git-ignored ones: the committed `*.example.*` files came from the clone, and
    // deleting them would leave the deploy checkout permanently dirty.
    for (const stale of ignoredFilesIn(appDir, rel)) {
      if (wanted.includes(stale)) continue;
      rmSync(join(appDir, rel, stale));
      console.log(`  remove: ${rel}/${stale}`);
    }
  }
}
```

Replace the last line of `main()`:

```ts
  if (flag("apply")) {
    apply(devDir, appDir);
    process.exit(0);
  }

  fail("Nothing to do: pass --check or --apply.", 1);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/deployFreeze.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy-freeze.ts tests/deploy/deployFreeze.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): copy config into the deploy checkout instead of linking it"
```

---

### Task 5: Rewire `herald-deploy.sh`, and fix the docs that describe the old behaviour

**Files:**
- Modify: `deploy/herald-deploy.sh:62-102` (the `link_ignored_config` block and the `.env` symlink), plus a new step 0
- Modify: `docs/ko/deploy.md:43-46`, `docs/ko/team-runbook.md:759-764`
- Test: `tests/deploy/heraldDeploy.test.ts` (create)

**Interfaces:**
- Consumes: the CLI contract from Tasks 3 and 4.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/heraldDeploy.test.ts`:

```ts
// tests/deploy/heraldDeploy.test.ts
//
// The script is read as text, the convention the rest of tests/deploy/ uses for shell and unit
// files. Two properties matter and neither is visible from the CLI's own tests: that the symlink is
// gone, and that the gate runs before the code moves. Gating after `git reset --hard origin/main`
// would refuse a deploy having already left the checkout on a commit nobody chose to deploy — the
// half-finished deploy the script's own header calls worse than none.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve(__dirname, "../../deploy/herald-deploy.sh"), "utf8");
const lineOf = (needle: string): number => {
  const i = script.split("\n").findIndex((l) => l.includes(needle));
  expect(i, `not found in herald-deploy.sh: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("herald-deploy.sh freezes configuration", () => {
  it("no longer symlinks anything into the deploy checkout", () => {
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("link_ignored_config");
  });

  it("gates before it moves the code", () => {
    expect(lineOf("deploy:freeze --check")).toBeLessThan(lineOf("reset --hard"));
  });

  it("applies after dependencies are installed", () => {
    expect(lineOf("deploy:freeze --apply")).toBeGreaterThan(lineOf("pnpm install"));
  });

  it("applies before the schema migration, which runs the frozen code", () => {
    expect(lineOf("deploy:freeze --apply")).toBeLessThan(lineOf("pnpm db:migrate"));
  });

  it("passes its own arguments through to the gate so --yes reaches it", () => {
    expect(script).toContain('deploy:freeze --check --dev "$DEV_DIR" --app "$APP_DIR" "$@"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/heraldDeploy.test.ts`
Expected: FAIL — `ln -sfn` and `link_ignored_config` are both still present.

- [ ] **Step 3: Write minimal implementation**

In `deploy/herald-deploy.sh`, insert immediately after the `echo "herald-deploy: …"` line (currently line 39):

```bash
# ── 0. Configuration gate ─────────────────────────────────────────────────────────────────────────
# Before anything destructive. Until 2026-08-09 the deploy checkout's .env was a symlink into
# $DEV_DIR, so production's configuration was the development checkout's, read fresh at every timer
# fire — the same exposure the deploy checkout closed for code on 2026-08-07, still open on the
# config axis. It is a copy now, taken here, and this gate prints what the copy would change (names
# only, never values) and stops unless --yes says the change is intended.
#
# It runs before the `git reset --hard` below and not next to the copy in step 3, because refusing
# after the code has already moved is exactly the half-finished deploy this script's header rules
# out. Read-only: nothing on disk changes until step 3.
pnpm deploy:freeze --check --dev "$DEV_DIR" --app "$APP_DIR" "$@"
```

Then delete lines 62-102 — the whole `link_ignored_config` function, its three call sites, the
`ln -sfn "$DEV_DIR/.env" "$APP_DIR/.env"` line and their comment block — and put in their place:

```bash
# ── 3. Freeze the git-ignored configuration ───────────────────────────────────────────────────────
# Copies .env and every git-ignored file under translation/, conversion/ and keys/ from the
# development checkout. The list is DERIVED, never hardcoded — `git check-ignore` decides, so a
# steering file added later is picked up with no edit here. Step 0 already showed and gated the
# change; this is the write.
pnpm deploy:freeze --apply --dev "$DEV_DIR" --app "$APP_DIR"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/deploy/heraldDeploy.test.ts && pnpm test && pnpm typecheck`
Expected: PASS — 5 new tests, the full suite green, no type errors.

- [ ] **Step 5: Update the two documents that describe the old behaviour**

In `docs/ko/deploy.md`, in "지켜야 할 것 네 가지", replace item 3 with:

```markdown
3. **`.env`는 건드리지 않습니다.** 리허설·드라이런은 별도 env 파일을 만들어 `--env-file`로
   주입합니다. 2026-08-09부터 이 규칙은 규율이 아니라 장치입니다 — 스케줄러는 `.env`를 링크로
   보지 않고 배포 시점 사본으로 봅니다. 그래도 다음 `bash deploy/herald-deploy.sh`가 지금 `.env`를
   프로덕션으로 옮기므로, 실험을 남겨둔 채 배포하면 게이트가 이름을 보여주고 멈춥니다.
```

In `docs/ko/team-runbook.md`, replace the two bullets at lines 762-764 with:

```markdown
- **설정은 링크가 아니라 배포 시점 사본입니다.** 예전에는 심볼릭 링크라 개발 체크아웃의 `.env`를
  고치는 순간 다음 타이머 발화가 그 값으로 돌았습니다. 지금은 `pnpm deploy:freeze`가 배포할 때
  복사하고, 무엇이 바뀌는지 **이름만** 출력한 뒤 `--yes` 없이는 멈춥니다.
- **목록은 하드코딩이 아니라 유도됩니다.** 개발 체크아웃에서 git이 무시하는 파일이면 전부
  대상입니다 — 나중에 추가된 스티어링 파일도 스크립트를 고치지 않고 따라옵니다.
- **`~/.herald/prod.env`는 그대로입니다.** `DATABASE_URL`과 `HERALD_DB_ENV=production` 두 줄,
  `EnvironmentFile=`로 주입되고 셸 환경이 Node의 `--env-file`을 이기므로 사본의 로컬 DB 주소를
  계속 덮습니다.
```

- [ ] **Step 6: Commit**

```bash
git add deploy/herald-deploy.sh tests/deploy/heraldDeploy.test.ts docs/ko/deploy.md docs/ko/team-runbook.md
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): freeze scheduler config at deploy time, gated by a name-only diff"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the three-surface layering and the unchanged
`prod.env` are asserted in Task 5's doc change and left untouched in code; the symlink removal is
Tasks 4-5; the name-only diff is Tasks 2-3; `chmod 600` and the steering-mode exception are Task 4;
the missing-`.env` refusal, the symlink-as-no-snapshot rule, the "nothing changed" path, stale
steering deletion and temp-file-then-rename are each a test in Tasks 3-4; gate ordering is Task 5.
The spec's three out-of-scope items stay out of scope.

**Naming.** `tests/deploy/heraldDeploy.test.ts` here versus `tests/deploy/herald-deploy.test.ts` in
the spec — the repo's test files are camelCase (`workingDirectory`, `runLogging`, `notifyFailure`),
so the plan's name is the correct one and the spec line should be amended to match.

**Types.** `NameDiff` is produced in Task 2 and consumed unchanged in Tasks 3-4. `STEERING_DIRS`,
`ignoredFilesIn` and `readSnapshot` are exported in Task 3 and reused in Task 4 under the same
names. `formatFreezeDiff(label, diff)` keeps its two-argument shape at every call site.
