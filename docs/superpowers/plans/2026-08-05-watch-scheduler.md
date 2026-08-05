# Watch Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm watch` walks collection → translation → alignment in one unattended pass and stops at `status: "translated"`, driven by a systemd user timer every two hours.

**Architecture:** Hexagonal, mirroring the repo's existing CLIs. A `WorksheetAgent` port hides the `claude -p` subprocess; a `WatchTick` use-case owns every sequencing decision (which stages run, which are skipped, what counts as failure) against that port; a thin `src/cli/watch.ts` wires real adapters and maps the result to an exit code. The systemd units are static assets under a new top-level `deploy/`.

**Tech Stack:** ESM TypeScript, `vitest`, `tsx`, `zod`-only runtime dep, `node:child_process` for the agent subprocess, systemd user units.

**Spec:** `docs/superpowers/specs/2026-08-05-watch-scheduler-design.md`

## Global Constraints

- Runtime deps stay **zod-only**. Add no dependency.
- **`--approve` must never appear in any command this feature builds.** The human gate is 1차 검수.
- No send, no publish, no conversion, no channel formatting, no `tm:promote`.
- Code and commit messages in English; `docs/ko/` in Korean.
- `.env` is never written or modified by anything in this plan.
- Public repo: synthetic data only in tests — no steering content, no real post text, no PII.
- Every test must be able to fail: pin concrete values, never an assertion a mutation would still satisfy.
- Batch cap is **3** (`--limit 3`) for both `translate:prepare` and `translate:align`.
- Timer is `OnCalendar=*-*-* 0/2:17:00`, `Persistent=true`.

## Files

| | Responsibility |
| --- | --- |
| `src/ports/WorksheetAgent.ts` | the one interface `WatchTick` needs from "something that fills a worksheet" |
| `src/app/WatchTick.ts` | every sequencing decision; pure of subprocesses and `process.exit` |
| `src/adapters/agent/ClaudeCodeAgent.ts` | spawns `claude -p`, parses `--output-format json` |
| `src/adapters/agent/runStage.ts` | spawns one `pnpm <script>`, captures stdout + exit code |
| `src/cli/watch.ts` | wiring + exit code only |
| `package.json` | the `watch` script |
| `deploy/herald-watch.service` | `Type=oneshot`, `OnFailure=`, explicit `PATH`/`WorkingDirectory` |
| `deploy/herald-watch.timer` | the schedule |
| `deploy/herald-notify-failure.sh` | one Telegram line on failure |
| `.vercelignore` | `/deploy/` — anchored |
| `.env.example` | `TELEGRAM_CHAT_ID_OPS` |
| `docs/ko/team-runbook.md` | install / inspect / pause / read logs |
| `CHANGELOG.md` | `[Unreleased]` entry |

**Read before starting:** `src/cli/collect.ts` and `src/cli/translate-prepare.ts` (the CLI shape and how they close the db), `src/cli/args.ts` (`argValue`), `src/cli/registerErrorHandler.ts` (why every CLI imports it first), `tests/support/` (the test helpers available), and the spec.

---

## Task 1: The `WorksheetAgent` port and `WatchTick`'s collect gate

**Files:**
- Create: `src/ports/WorksheetAgent.ts`
- Create: `src/app/WatchTick.ts`
- Test: `tests/app/watchTick.test.ts`

**Interfaces:**
- Produces:
  - `type StageResult = { ok: true; stdout: string } | { ok: false; stage: string; detail: string }`
  - `type StageRunner = (script: string, args: string[]) => Promise<StageResult>`
  - `interface WorksheetAgent { fill(worksheetPath: string, kind: "translation" | "alignment"): Promise<StageResult> }`
  - `class WatchTick { constructor(run: StageRunner, agent: WorksheetAgent); run(): Promise<TickReport> }`
  - `type TickReport = { ok: boolean; stagesRun: string[]; failure?: { stage: string; detail: string } }`

**Invariants this task must satisfy** (do not copy an implementation from here — derive it):

- `run()` calls `collect` first, always.
- If `collect`'s stdout indicates **zero new threads**, `run()` returns `ok: true` and **never touches `agent`**.

  `src/cli/collect.ts:42` prints exactly one line of this shape:

  ```
  collected 3 threads (7 tweets) for @Mantle_Official — covered 2026-08-05T… ~ 2026-08-05T…
  collected 0 threads (0 tweets) for @Mantle_Official — nothing new in window
  ```

  Match the leading count. **Unrecognised stdout is a failure, not "nothing new"** — the lenient
  reading turns a broken collector into a scheduler that reports success forever while doing
  nothing, which is the one failure mode nobody would notice.
- A failing stage short-circuits: no later stage runs, and `failure.stage` names the stage that failed.
- `WatchTick` performs no I/O of its own — no `spawn`, no `fs`, no `process.exit`. Everything arrives through `run` and `agent`. Parsing a stage's stdout is string work, not I/O.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/app/watchTick.test.ts
import { describe, it, expect } from "vitest";
import { WatchTick } from "../../src/app/WatchTick";
import type { StageResult, WorksheetAgent } from "../../src/ports/WorksheetAgent";

function recordingAgent() {
  const calls: string[] = [];
  const agent: WorksheetAgent = {
    async fill(_path, kind) {
      calls.push(kind);
      return { ok: true, stdout: "saved" };
    },
  };
  return { agent, calls };
}

describe("WatchTick", () => {
  it("stops after collect when nothing is new, without calling the agent", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      return { ok: true, stdout: "collected 0 threads (0 tweets) for @x — nothing new in window" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });

  it("reports the failing stage and runs nothing after it", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      return { ok: false, stage: script, detail: "ECONNREFUSED" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "collect", detail: "ECONNREFUSED" });
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test tests/app/watchTick.test.ts`
Expected: FAIL — `Cannot find module '../../src/app/WatchTick'`.

- [ ] **Step 3: Write `src/ports/WorksheetAgent.ts` and `src/app/WatchTick.ts`**

Types exactly as listed under **Interfaces** above. Implement only what the two tests demand — the collect gate and the short-circuit. Later stages come in Task 2.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test tests/app/watchTick.test.ts` → PASS. Then `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/ports/WorksheetAgent.ts src/app/WatchTick.ts tests/app/watchTick.test.ts
git commit -m "feat(watch): gate the tick on collect finding new items"
```

---

## Task 2: The translate and align stages

**Files:**
- Modify: `src/app/WatchTick.ts`
- Test: `tests/app/watchTick.test.ts` (extend; keep Task 1's cases green)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: no new exported names. `TickReport.stagesRun` now records the full sequence.

**Invariants:**

- With new items, the order is exactly: `collect` → `translate:prepare` → agent(`translation`) → `translate:align` → agent(`alignment`).
- Both `translate:prepare` and `translate:align` are invoked with `--limit 3`.
- **`prepared 0 item(s)` skips the translation agent call** and goes straight to `translate:align`. `translate-prepare.ts` writes a worksheet unconditionally, so a zero-item batch still produces a file — calling the agent on it would spend a subscription turn to translate nothing. This happens whenever `collect` re-reads a thread that is already translated.
- When `translate:align` reports it aligned nothing, the **alignment** agent call is skipped and the tick still reports success.
- The worksheet path handed to `agent.fill` is the one the preceding stage printed — parse it from that stage's stdout rather than re-deriving a timestamped filename, which would race the stage that wrote it.

Exact stdout shapes, verified by reading the two CLIs. Both print a **second** line after the one
you parse, so match a line, not the whole buffer:

```
src/cli/translate-prepare.ts:56   prepared 2 item(s) → output/translations/worksheets/batch-<stamp>.md
src/cli/translate-align.ts:42     aligned 2 · skipped 1 (no precedent) → output/translations/worksheets/align-<stamp>.md
src/cli/translate-align.ts:36     nothing to align · skipped 1 (no precedent)
```
- **No argument list this class builds ever contains `--approve`.**

- [ ] **Step 1: Write the failing tests**

```typescript
  it("runs both agent passes in order when there is work", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      ran.push([script, ...args].join(" "));
      if (script === "collect") return { ok: true, stdout: "collected 2 threads (5 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: "aligned 2 · skipped 0 (no precedent) → output/translations/worksheets/align-X.md" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["translation", "alignment"]);
    expect(ran).toEqual([
      "collect",
      "translate:prepare --limit 3",
      "translate:align --limit 3",
    ]);
  });

  it("translates but skips alignment when there is no precedent", async () => {
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: "nothing to align · skipped 1 (no precedent)" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    // Not `[]` — the translation pass must still have run. Asserting only the
    // absence of "alignment" would also pass if the tick did nothing at all.
    expect(calls).toEqual(["translation"]);
  });

  it("skips the translation pass when the batch prepared nothing", async () => {
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 0 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: "nothing to align · skipped 0 (no precedent)" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("never passes --approve to any stage", async () => {
    const { agent } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      ran.push([script, ...args].join(" "));
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
    };

    await new WatchTick(run, agent).run();

    expect(ran.length).toBeGreaterThan(1); // guard: a no-op tick would pass vacuously
    expect(ran.join(" ")).not.toContain("--approve");
  });
```

**Pass `agent` — the one you destructured — into `WatchTick`.** Constructing a second
`recordingAgent()` for the call while asserting on the first one's `calls` makes both tests pass no
matter what the implementation does.

- [ ] **Step 2: Run and confirm the new tests fail, old ones pass**

Run: `pnpm test tests/app/watchTick.test.ts`

- [ ] **Step 3: Extend `WatchTick`**

Satisfy the invariants above. Keep the class free of I/O.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test tests/app/watchTick.test.ts` → PASS. `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/WatchTick.ts tests/app/watchTick.test.ts
git commit -m "feat(watch): sequence the translate and align passes"
```

---

## Task 3: The `claude -p` adapter

**Files:**
- Create: `src/adapters/agent/ClaudeCodeAgent.ts`
- Test: `tests/adapters/agent/claudeCodeAgent.test.ts`

**Interfaces:**
- Consumes: `WorksheetAgent`, `StageResult` from Task 1.
- Produces: `class ClaudeCodeAgent implements WorksheetAgent`, constructed with an injectable spawn function so tests never launch a real process:
  `constructor(spawnFn: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>)`

**Invariants:**

- Builds a `claude -p` invocation carrying `--output-format json` and an `--allowedTools` allowlist narrow enough to read the worksheet, write the Korean text, and run `translate:save`. It must **not** pass `--dangerously-skip-permissions`.
- **The prompt must forbid `--approve` in so many words.** This is not belt-and-braces: `translate:prepare` itself prints
  `run: pnpm translate:save --id <id> --file <korean.txt> [--approve]`
  as its closing line (`src/cli/translate-prepare.ts:57`), and the worksheet carries similar guidance. An unattended agent reading its own tooling's instructions is being actively invited to approve. Say plainly that a human performs 1차 검수 and the agent never approves. Consider also excluding `--approve` from the `--allowedTools` Bash pattern, so the allowlist enforces what the prompt asks for.
- A non-zero exit → `{ ok: false }` with `stderr` (truncated) as the detail.
- Exit 0 with **unparseable** stdout → `{ ok: false }`. Do not treat it as success. A crashed agent that still exits 0 would otherwise be recorded as a completed translation pass.

`--output-format json` emits a single-line object. Captured from a real run on this machine — these
are the fields that matter, not a guess:

```json
{"is_error":false,"subtype":"success","type":"result","result":"ok",
 "stop_reason":"end_turn","terminal_reason":"completed","permission_denials":[],
 "num_turns":1,"session_id":"c910…","total_cost_usd":0.21331}
```

Three success conditions, all required:

- **exit code 0**
- **`is_error === false`**
- **`permission_denials` is empty** — this one is not optional and is easy to miss. If the
  `--allowedTools` allowlist is too narrow to let the agent run `translate:save`, the run still
  exits 0 with `is_error: false`; the only trace is an entry here. Treating that as success gives
  exactly the failure this whole feature is built to avoid: a scheduler reporting green forever
  while saving nothing. A non-empty `permission_denials` is a failure, and its contents belong in
  the detail so the Telegram message names the tool that was blocked.
- The prompt text lives in this file as a named constant, so a reviewer can read what the unattended agent is told without running anything.

Consult `claude --help` (under a pty: `script -qec 'stty cols 200; claude --help' /dev/null`) for the exact spelling of every flag before writing them.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/adapters/agent/claudeCodeAgent.test.ts
import { describe, it, expect } from "vitest";
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

describe("ClaudeCodeAgent", () => {
  it("asks for json output and never skips permissions", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: '{"result":"saved 1"}', stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    expect(seen).toContain("--output-format");
    expect(seen).toContain("json");
    expect(seen).not.toContain("--dangerously-skip-permissions");
    expect(seen.join(" ")).not.toContain("--approve");
  });

  it("fails when the agent exits non-zero", async () => {
    const agent = new ClaudeCodeAgent(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("boom");
  });

  it("fails on a zero exit with unparseable output", async () => {
    const agent = new ClaudeCodeAgent(ok("Killed"));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test tests/adapters/agent/claudeCodeAgent.test.ts`

- [ ] **Step 3: Implement the adapter**

- [ ] **Step 4: Run tests and typecheck**

- [ ] **Step 5: Commit**

```bash
git add src/adapters/agent/ClaudeCodeAgent.ts tests/adapters/agent/claudeCodeAgent.test.ts
git commit -m "feat(watch): spawn claude -p and refuse to read a crash as success"
```

---

## Task 4: The stage runner and the CLI

**Files:**
- Create: `src/adapters/agent/runStage.ts`
- Create: `src/cli/watch.ts`
- Modify: `package.json`
- Test: `tests/adapters/agent/runStage.test.ts`

**Interfaces:**
- Consumes: `StageResult`, `StageRunner`, `WatchTick`, `ClaudeCodeAgent`.
- Produces: `export const runStage: StageRunner`.

**Invariants:**

- `runStage` spawns `pnpm <script> <args...>` in the repo root and returns `{ ok: false, stage: script, detail }` on a non-zero exit, with stderr in the detail.
- `src/cli/watch.ts` imports `./registerErrorHandler` first, like every other CLI in `src/cli/`.
- The CLI's only logic is: build `WatchTick`, run it, print a one-line summary, exit `0` on success and `1` on failure. **No sequencing decisions live here** — they are all in `WatchTick`, where they are tested.
- The CLI does **not** open a database connection. Each stage it spawns opens and closes its own; adding another would hold a connection open for the whole run, including while `claude` is thinking.
- `package.json` gains `"watch": "tsx --env-file-if-exists=.env src/cli/watch.ts"`, matching the other entries.

- [ ] **Step 1: Write the failing test for `runStage`**

```typescript
// tests/adapters/agent/runStage.test.ts
import { describe, it, expect } from "vitest";
import { runStage } from "../../../src/adapters/agent/runStage";

describe("runStage", () => {
  it("reports failure with the stage name when the script exits non-zero", async () => {
    const result = await runStage("this-script-does-not-exist", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("this-script-does-not-exist");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `runStage` and `src/cli/watch.ts`, add the `watch` script**

- [ ] **Step 4: Run tests, both typechecks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm typecheck:web`.

- [ ] **Step 5: Verify the wiring end to end against the dev database**

Run: `pnpm watch`

Expected: it reaches `collect` and either stops there (no new items — the normal outcome) or proceeds. Confirm the printed summary names the stages that ran. **Do not point this at the production DSN yet.**

- [ ] **Step 6: Commit**

```bash
git add src/adapters/agent/runStage.ts src/cli/watch.ts tests/adapters/agent/runStage.test.ts package.json
git commit -m "feat(watch): add the pnpm watch entrypoint"
```

---

## Task 5: systemd units, the failure hook, and `.vercelignore`

**Files:**
- Create: `deploy/herald-watch.service`, `deploy/herald-watch.timer`, `deploy/herald-notify-failure.sh`
- Modify: `.vercelignore`, `.env.example`
- Test: `tests/deploy/vercelignore.test.ts` (extend)

**Invariants:**

- `.vercelignore` gains **`/deploy/`** — anchored with a leading slash. An unanchored `deploy/` matches every depth and would drop `src/deploy/` from the function bundle. Read the comment at the top of `.vercelignore` for why this rule exists.
- `herald-watch.service` is `Type=oneshot`, sets `WorkingDirectory` to the repo, sets an explicit `PATH` covering `pnpm`, `node` and `claude` (find them with `command -v`), sources the production env, and declares `OnFailure=`.
- `herald-watch.timer` uses `OnCalendar=*-*-* 0/2:17:00` and `Persistent=true`. Verify with `systemd-analyze calendar '*-*-* 0/2:17:00'` before committing.
- `herald-notify-failure.sh` sends **one** line to Telegram naming the unit and the `journalctl` command to read it. It must exit 0 even when Telegram is unreachable — a failing failure-handler is a loop.
- `.env.example` gains `TELEGRAM_CHAT_ID_OPS` in the Telegram section with a comment saying it receives scheduler failures only.
- The units are **not** installed by any committed script. Installation is a documented copy in Task 6.

- [ ] **Step 1: Extend the `.vercelignore` test to require the anchored entry**

```typescript
  it("excludes the top-level deploy/ without touching src/deploy/", () => {
    expect(patterns).toContain("/deploy/");
    expect(patterns).not.toContain("deploy/");
  });
```

Read `tests/deploy/vercelignore.test.ts` first — reuse however it already parses the file rather than reading it again.

- [ ] **Step 2: Run and confirm it fails**

- [ ] **Step 3: Write the three `deploy/` files, the `.vercelignore` line, and the `.env.example` entry**

- [ ] **Step 4: Verify**

Run: `pnpm test tests/deploy/`, and `systemd-analyze calendar '*-*-* 0/2:17:00'`.

- [ ] **Step 5: Commit**

```bash
git add deploy/ .vercelignore .env.example tests/deploy/vercelignore.test.ts
git commit -m "feat(watch): add the systemd units and failure hook"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/ko/team-runbook.md`, `CHANGELOG.md`

**Invariants:**

- The runbook section is **Korean**, and covers: creating `~/.herald/prod.env` (two lines, `chmod 600`), copying the units to `~/.config/systemd/user/`, `systemctl --user enable --now herald-watch.timer`, checking with `systemctl --user list-timers`, running one tick on demand with `systemctl --user start herald-watch.service`, reading `journalctl --user -u herald-watch`, and pausing with `systemctl --user stop`.
- It states plainly that **the scheduler never approves anything** and that its output lands in 1차 검수.
- It says not to run `pnpm watch` by hand while the timer is armed, and gives `systemctl --user start` as the correct way.
- `CHANGELOG.md` is **English** and gains an `[Unreleased]` entry.
- Every command in the runbook must be one you actually ran. Do not document a flag you have not executed.

- [ ] **Step 1: Write the runbook section and CHANGELOG entry**

- [ ] **Step 2: Verify every command in the section runs**

Paste each one into a shell and confirm it behaves as documented. `systemctl --user list-timers` should show the timer after enabling.

- [ ] **Step 3: Commit**

```bash
git add docs/ko/team-runbook.md CHANGELOG.md
git commit -m "docs: document the watch scheduler"
```

---

## Task 7: Live verification

No new files. This is the task that decides whether the feature works.

- [ ] **Step 1: Full suite green**

Run: `pnpm test`, `pnpm typecheck`, `pnpm typecheck:web`. All clean.

- [ ] **Step 2: Kyle creates `~/.herald/prod.env`**

Two lines — `DATABASE_URL` (production Neon) and `HERALD_DB_ENV=production` — then `chmod 600`. **A production DSN does not pass through an agent session; this step is Kyle's.**

- [ ] **Step 3: One tick against production, watched**

Run: `systemctl --user start herald-watch.service`, then `journalctl --user -u herald-watch -n 50`.

Confirm the log shows which stages ran. If `collect` found nothing, that is a pass for the wiring but not for the pipeline — say so plainly rather than reporting success.

- [ ] **Step 4: Confirm the board, not the log**

Open the hosted dashboard. If the tick translated anything, it appears as `translated`, awaiting 1차 검수 — **with no redeploy**. If it does not appear, the log is not evidence; the board is.

- [ ] **Step 5: Prove the failure path**

Temporarily point `~/.herald/prod.env` at an unreachable host, run one tick, and confirm a Telegram message arrives naming the failing stage. Restore the file. An untested alerting path is an assumption, and this one is the only thing standing between a dead scheduler and nobody noticing.

- [ ] **Step 6: Arm the timer**

Run: `systemctl --user enable --now herald-watch.timer`, then `systemctl --user list-timers` and confirm `NEXT` is the coming `:17`.

- [ ] **Step 7: Open the PR**

Push the branch and open a PR against `main`. Never merge locally.
