# Ops Alert Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram alert carry what the failing command actually printed, formatted so an operator can read it on a phone.

**Architecture:** Invert the excerpt's source — read the durable per-run log first, the journal only when there is none. Then dress both senders (`deploy/herald-notify-failure.sh` in bash, `src/shared/notifyOps.ts` in TypeScript) in one shared grammar with `parse_mode: "HTML"`, guarded by escaping and a plain-text retry.

**Tech Stack:** bash 5 (systemd `OnFailure=` hook), TypeScript + vitest, Telegram Bot API `sendMessage`.

## Global Constraints

- Commit identity: `git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com'`.
- The hook must reach `exit 0` on every path. An alert failure must never fail a systemd unit.
- `parse_mode` is `HTML`, never MarkdownV2 — `src/domain/formatting/emitters/telegram.ts:29` records why.
- Korean chrome, log content verbatim.
- `LOG_TAIL_LINES=5`, `ALERT_MARKER="HERALD_ALERT: "`, `JOURNAL_READ_TIMEOUT=6`, `ALERT_SCAN_LINES=200`, `ALERT_SCAN_MAX_BYTES=262144`, `ALERT_MAX_LINES=3`, `ALERT_MAX_CHARS=250`, `ALERT_EXCERPT_MAX_CHARS=500` keep their current values unless a task says otherwise.
- Never read or print a value from `.env`. Presence checks only.
- Do not install units, run `systemctl`, or send a real Telegram message. Always stub `curl`.

---

### Task 1: Read the run log first

**Files:**
- Modify: `deploy/herald-notify-failure.sh:119-152`
- Test: `tests/deploy/notifyFailure.test.ts`

**Interfaces:**
- Consumes: `deploy/herald-run-logged.sh`'s log root, `${HERALD_LOG_DIR:-$HOME/.herald/logs}/<unit>/<utc>.log`, and its `=== <unit> started … ===` / `=== <unit> exited <n> at … ===` boundary lines.
- Produces: `LOG_EXCERPT`, `LOG_POINTER`, and a new `EXCERPT_SOURCE` (`runlog` | `journal` | `none`) that Tasks 2 reads.

- [ ] **Step 1: Write the failing test**

Add to `tests/deploy/notifyFailure.test.ts`. The helpers `writeRunLog`, `runScript`, `readCurlBody` already exist in that file — reuse them exactly as the neighbouring tests do.

```ts
  it("prefers the durable run log over the journal, so systemd's own lines cannot crowd out the command's", async () => {
    // The 2026-08-07 alert: journald attributes systemd's post-exit messages to the unit, and they
    // are always last, so a five-line tail of the JOURNAL is five lines of systemd talking about
    // itself. The run log holds only what the command printed.
    process.env.STUB_JOURNAL_OUTPUT = [
      "herald-x-reconcile.service: Main process exited, code=exited, status=1/FAILURE",
      "herald-x-reconcile.service: Failed with result 'exit-code'.",
      "Failed to start herald-x-reconcile.service - Mantle KR Herald X publish reconcile.",
      "herald-x-reconcile.service: Triggering OnFailure= dependencies.",
      "herald-x-reconcile.service: Consumed 2.021s CPU time.",
    ].join("\n");
    await writeRunLog(TEST_UNIT, [
      `=== ${TEST_UNIT} started 2026-08-07T09:42:00Z — pnpm x:reconcile --yes ===`,
      "writing…",
      "  ✗ x:2085765414248968281 publish failed — HTTP 429",
      "wrote 0, retired 0, failed 1.",
      `=== ${TEST_UNIT} exited 1 at 2026-08-07T09:42:09Z ===`,
    ]);

    const res = await runScript(TEST_UNIT);
    expect(res.status).toBe(0);
    const body = await readCurlBody();

    expect(body, "the command's own failing line must be in the alert").toContain("HTTP 429");
    expect(body).toContain("wrote 0, retired 0, failed 1.");
    // The whole complaint, asserted directly.
    expect(body, "systemd's own noise must not appear").not.toContain("Consumed 2.021s CPU time");
    expect(body).not.toContain("Main process exited");
    expect(body).not.toContain("Triggering OnFailure=");
    // The pointer names the source that was actually used.
    expect(body).toContain("tail -n 50 ");
    expect(body).not.toContain("journalctl --user -u");
  });

  it("falls back to the journal when there is no run log at all", async () => {
    process.env.STUB_JOURNAL_OUTPUT = "the only record of this run\nsecond line";
    // No writeRunLog call: this unit never reached the wrapper.
    const res = await runScript(TEST_UNIT);
    expect(res.status).toBe(0);
    const body = await readCurlBody();
    expect(body).toContain("the only record of this run");
    expect(body).toContain("journalctl --user -u");
  });

  it("falls back to the journal when the run log exists but is empty", async () => {
    process.env.STUB_JOURNAL_OUTPUT = "journal had it";
    await writeRunLog(TEST_UNIT, []);
    const res = await runScript(TEST_UNIT);
    expect(res.status).toBe(0);
    expect(await readCurlBody()).toContain("journal had it");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/notifyFailure.test.ts`
Expected: FAIL — the first test's `not.toContain("Consumed 2.021s CPU time")` fails, because the journal is still read first.

- [ ] **Step 3: Write the implementation**

Replace `deploy/herald-notify-failure.sh:119-152` (from `LOG_EXCERPT="$(journal_read …` through the closing `fi` of the run-log fallback) with:

```sh
# ── Where the excerpt comes from, and why the run log wins ───────────────────────────────────────
#
# The run log is read FIRST, and this is the whole point of `deploy/herald-run-logged.sh` existing.
#
# journald attributes systemd's own messages about a unit to that unit — `Main process exited`,
# `Failed with result`, `Failed to start`, `Triggering OnFailure=`, `Consumed … CPU time` — and it
# emits them AFTER the process exits, so they are always the last lines. Reading the journal first
# therefore spent the entire five-line budget on systemd talking about itself. A real alert, from
# 2026-08-07, arrived as six lines of which five were that, and nothing about what `pnpm x:reconcile`
# had done wrong. The journal is never empty for a unit that just failed, so the run-log fallback
# below it almost never fired: the wrapper had been writing exactly the right content all along and
# the hook was not looking at it.
#
# The run log holds the command's own output plus the wrapper's two boundary lines, and nothing else.
# It is also one file per run, so the marked-line scan over it is run-scoped by construction —
# the `awk` anchoring further down is needed only on the journal path now.
#
# Newest by NAME, not by mtime: the run logs are UTC-timestamped, `ls -1` sorts them
# lexicographically, and mtime ordering is exactly what this machine's constantly stepping clock
# makes untrustworthy.
#
# Same root expression as the wrapper's, character for character — tests/deploy/runLogging.test.ts
# pins the two equal, because a wrapper writing where this hook does not look is a fallback that
# silently never fires while both scripts keep passing their own tests.
LOG_EXCERPT=""
LOG_POINTER=""
EXCERPT_SOURCE="none"
RUN_LOG=""

LOG_ROOT="${HERALD_LOG_DIR:-${HOME:-}/.herald/logs}"
RUN_LOG_DIR="$LOG_ROOT/${UNIT%.service}"
RUN_LOG="$(ls -1 "$RUN_LOG_DIR"/*.log 2>/dev/null | tail -n 1)" || RUN_LOG=""
if [ -n "$RUN_LOG" ]; then
  LOG_EXCERPT="$(tail -n "$LOG_TAIL_LINES" "$RUN_LOG" 2>/dev/null)" || LOG_EXCERPT=""
  if [ -n "$LOG_EXCERPT" ]; then
    LOG_POINTER="tail -n 50 ${RUN_LOG}"
    EXCERPT_SOURCE="runlog"
  fi
fi

# Journal fallback: the unit never reached the wrapper (a misconfigured ExecStart=, a unit added
# without it), or could not write under %h/.herald/logs. Captured with `--output=cat` to drop
# journalctl's own timestamp/hostname prefix — redundant here, since the alert's arrival time
# already says when. Never fatal on its own: an unreadable journal degrades to an empty excerpt via
# `|| true`, not a script failure. This hook still has to reach `exit 0` regardless.
if [ -z "$LOG_EXCERPT" ]; then
  LOG_EXCERPT="$(journal_read --user -u "$UNIT" -n "$LOG_TAIL_LINES" --no-pager --output=cat)" || LOG_EXCERPT=""
  if [ -n "$LOG_EXCERPT" ]; then
    LOG_POINTER="journalctl --user -u ${UNIT} -n 50 --no-pager"
    EXCERPT_SOURCE="journal"
  fi
fi

# Neither source had anything. The pointer is still worth sending — it is what the excerpt exists to
# make unnecessary, not a replacement for it.
[ -z "$LOG_POINTER" ] && LOG_POINTER="journalctl --user -u ${UNIT} -n 50 --no-pager"
```

Then find the marked-line block's journal guard, currently:

```sh
if [ "$ALERT_FROM_JOURNAL" -eq 1 ] && [ -n "$ALERT_WINDOW" ]; then
```

and change its condition to read the new variable, since `ALERT_FROM_JOURNAL` no longer exists:

```sh
if [ "$EXCERPT_SOURCE" = "journal" ] && [ -n "$ALERT_WINDOW" ]; then
```

Search the file for every other use of `ALERT_FROM_JOURNAL` and repoint it the same way. Update the marked-line window read so it scans the **run log** when that is the source, mirroring the excerpt's preference — the existing `ALERT_WINDOW` assignment already has both a `journal_read` form and a `tail -n "$ALERT_SCAN_LINES" "$RUN_LOG"` form; make the run-log form the one taken when `EXCERPT_SOURCE = runlog`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/deploy/notifyFailure.test.ts tests/deploy/notifyFailureMarker.test.ts`
Expected: all pass. Several existing tests in `notifyFailureMarker.test.ts` set only `STUB_JOURNAL_OUTPUT` and now need a run log, or need `HERALD_LOG_DIR` pointed at an empty directory to keep exercising the journal path. **Fix them by making their intent explicit** — a test that meant "journal branch" should point `HERALD_LOG_DIR` at an empty temp dir and say so in a comment. Do not weaken an assertion to make it pass.

- [ ] **Step 5: Commit**

```bash
git add deploy/herald-notify-failure.sh tests/deploy/notifyFailure.test.ts tests/deploy/notifyFailureMarker.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "fix(deploy): read the command's own log before systemd's account of it"
```

---

### Task 2: The alert's shape, in HTML, with a retry

**Files:**
- Modify: `deploy/herald-notify-failure.sh` (the `json_escape` neighbourhood and the message-assembly block at 366-402)
- Test: `tests/deploy/notifyFailure.test.ts`

**Interfaces:**
- Consumes: `EXCERPT_SOURCE`, `LOG_EXCERPT`, `LOG_POINTER`, `ALERT_TEXT`, `ALERT_NOTE` from Task 1 and the existing marker block.
- Produces: the wire grammar Task 3 must match — a header line `⚠ <unit> 실패 (exit <n>)`, optional plain lines, a `<pre>…</pre>` block, and a final `↳ <pointer>` line.

- [ ] **Step 1: Write the failing test**

```ts
  it("sends HTML: a monospace excerpt, an escaped body, and a header naming the exit code", async () => {
    process.env.STUB_JOURNAL_OUTPUT = "";
    await writeRunLog(TEST_UNIT, [
      "  ✓ live: google_drive_review  reachable",
      "  ✗ live: google_auth          400 <invalid_grant> & dead",
      "6 ok · 0 warn · 1 fail",
    ]);
    await runScript(TEST_UNIT);
    const body = await readCurlBody();
    const payload = JSON.parse(body) as { text: string; parse_mode?: string };

    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toMatch(/^⚠ .*실패/);
    expect(payload.text).toContain("<pre>");
    expect(payload.text).toContain("</pre>");
    // Escaped, or Telegram 400s and the alert vanishes.
    expect(payload.text).toContain("400 &lt;invalid_grant&gt; &amp; dead");
    expect(payload.text, "the raw form must not survive").not.toContain("<invalid_grant>");
    expect(payload.text).toContain("↳ ");
  });

  it("retries once as plain text when Telegram rejects the HTML", async () => {
    // A stray `<` that escaping missed must cost one message's formatting, not the message. curl's
    // own `|| true` already discards the failure, so without this the alert is simply gone.
    process.env.STUB_CURL_EXIT = "22"; // curl -f: HTTP error
    process.env.STUB_JOURNAL_OUTPUT = "";
    await writeRunLog(TEST_UNIT, ["something broke"]);
    await runScript(TEST_UNIT);

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
    process.env.STUB_JOURNAL_OUTPUT = "";
    await writeRunLog(TEST_UNIT, ["something broke"]);
    await runScript(TEST_UNIT);
    expect(await readAllCurlBodies()).toHaveLength(1);
  });
```

`readAllCurlBodies` does not exist yet. The curl stub currently overwrites `curl-body.log`; change it to **append** each body followed by a `\n ` record separator, add `readAllCurlBodies()` that splits on it, and keep `readCurlBody()` returning the first record so existing tests are untouched.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/notifyFailure.test.ts`
Expected: FAIL — `payload.parse_mode` is `undefined`; there is no `<pre>`; only one body is ever written.

- [ ] **Step 3: Write the implementation**

Add next to `json_escape`:

```sh
# HTML entity escaping, for `parse_mode: "HTML"`. Only three characters need it — the repo settled
# on HTML over MarkdownV2 for exactly that reason (src/domain/formatting/emitters/telegram.ts:29:
# MarkdownV2 needs 18, including `.`, `(`, `)` and `-`, all of which saturate Korean prose).
#
# `&` FIRST, or the ampersands this function itself introduces get escaped a second time and the
# operator reads `&amp;lt;`.
#
# This is not cosmetic. An unescaped `<` in a log line makes the message malformed HTML, Telegram
# answers 400, and `curl -fsS … || true` below discards that — so the alert disappears with no
# trace at either end. The plain-text retry is the second half of this guard; neither replaces the
# other, because escaping is what a future edit can get wrong and the retry is what makes getting it
# wrong survivable.
html_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}
```

Add the exit-code lookup just above the message assembly:

```sh
# The exit code separates a dead credential (1) from a machine-configuration error (2), and the
# operator should not have to infer which from the body. ExecMainStatus survives into the failed
# state, which is when this hook runs. `--value` needs systemd 246+; the wrapper's own footer is the
# fallback, and an unknown code degrades to a header with no code rather than a wrong one.
EXIT_CODE=""
if command -v systemctl >/dev/null 2>&1; then
  EXIT_CODE="$(systemctl --user show "$UNIT" -p ExecMainStatus --value 2>/dev/null)" || EXIT_CODE=""
fi
case "$EXIT_CODE" in ''|*[!0-9]*) EXIT_CODE="" ;; esac
if [ -z "$EXIT_CODE" ] && [ -n "$RUN_LOG" ]; then
  EXIT_CODE="$(sed -n "s/^=== ${UNIT} exited \([0-9][0-9]*\) at .*$/\1/p" "$RUN_LOG" 2>/dev/null | tail -n 1)" || EXIT_CODE=""
fi

HEADER="⚠ ${UNIT} 실패"
[ -n "$EXIT_CODE" ] && HEADER="${HEADER} (exit ${EXIT_CODE})"
```

Replace the `TEXT=` assembly inside the `if [ -n "$ALERT_TEXT" ] || …` branch with:

```sh
    # Header and marked lines are plain: they are the part that must stay readable when a phone is
    # narrow, and `<pre>` would let them scroll off to the right. The excerpt is `<pre>` because the
    # reports these units print are column-aligned and proportional text ruins them.
    TEXT="$(html_escape "$HEADER")"
    [ -n "$ALERT_TEXT" ] && TEXT="${TEXT}
$(html_escape "$ALERT_TEXT")"
    [ -n "$ALERT_NOTE" ] && TEXT="${TEXT}
$(html_escape "$ALERT_NOTE")"
    [ -n "$LOG_EXCERPT" ] && TEXT="${TEXT}
<pre>$(html_escape "$LOG_EXCERPT")</pre>"
    TEXT="${TEXT}
↳ $(html_escape "$LOG_POINTER")"
```

and the empty-sources branch with:

```sh
    TEXT="$(html_escape "${HEADER} — 실행 로그도 저널도 남지 않았습니다")
↳ $(html_escape "$LOG_POINTER")"
```

Replace the single `curl` call with a send function and the retry:

```sh
# One attempt as HTML, and if Telegram rejects it, one as plain text with the tags stripped.
#
# `-4`: this machine's IPv6 route to api.telegram.org is known broken while the AAAA record still
# resolves (see src/cli/preferIpv4.ts). `-m 10`: a hung request must not hold the unit open.
# `-fsS`: non-zero exit on an HTTP error, quiet on stdout, but `-S` still prints the error to
# stderr — deliberately NOT redirected, so a 401 on a stale token or a 400 on malformed HTML lands
# in `journalctl --user -u herald-notify-failure@${UNIT}.service`.
send_telegram() {
  local text=$1 mode=$2 payload
  if [ -n "$mode" ]; then
    payload="$(printf '{"chat_id":"%s","text":"%s","parse_mode":"%s"}' \
      "$TELEGRAM_CHAT_ID_OPS" "$(json_escape "$text")" "$mode")"
  else
    payload="$(printf '{"chat_id":"%s","text":"%s"}' \
      "$TELEGRAM_CHAT_ID_OPS" "$(json_escape "$text")")"
  fi
  curl -4 -fsS -m 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    >/dev/null
}

if ! send_telegram "$TEXT" "HTML"; then
  # Formatting cost us the message. Send the content unformatted rather than nothing: `<pre>` tags
  # out, entities back to their characters, no parse_mode. One retry, not a loop — the second
  # attempt uses the encoding that worked before this change, so a second failure is not about
  # formatting and repeating would only delay `exit 0`.
  PLAIN=${TEXT//<pre>/}
  PLAIN=${PLAIN//<\/pre>/}
  PLAIN=${PLAIN//&lt;/<}
  PLAIN=${PLAIN//&gt;/>}
  PLAIN=${PLAIN//&amp;/&}
  send_telegram "$PLAIN" "" || true
fi
```

Keep the whole thing inside the existing `if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID_OPS" ]` guard, and keep `exit 0` at the end of the file.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/deploy/ && pnpm typecheck`
Expected: green. Existing assertions that matched the old `⚠ <unit> failed` header or the `— <pointer>` line need updating to the new grammar; update them, do not delete them.

- [ ] **Step 5: Commit**

```bash
git add deploy/herald-notify-failure.sh tests/deploy/notifyFailure.test.ts tests/deploy/notifyFailureMarker.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(deploy): format the failure alert, and survive Telegram rejecting it"
```

---

### Task 3: `notifyOps` speaks the same grammar

**Files:**
- Create: `src/shared/opsAlertGrammar.ts`
- Create: `tests/deploy/opsAlertGrammar.test.ts`
- Modify: `src/shared/notifyOps.ts`, `src/cli/xReconcileReport.ts:113-128`
- Test: `tests/shared/notifyOps.test.ts`, `tests/cli/xReconcileReport.test.ts`

**Interfaces:**
- Consumes: Task 2's wire grammar.
- Produces: `escapeTelegramHtml(s: string): string`, `opsNotice(opts: { icon: "ℹ" | "⚠"; title: string; lines?: string[] }): string` from `src/shared/opsAlertGrammar.ts`.

- [ ] **Step 1: Write the failing test**

`tests/deploy/opsAlertGrammar.test.ts`:

```ts
// The two senders — deploy/herald-notify-failure.sh (bash) and src/shared/notifyOps.ts — write to
// the same Telegram room and cannot share code. notifyOps's own header says it "deliberately
// mirrors that script's env contract"; a resemblance nothing checks is a resemblance that drifts.
// This file is the check.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";
import { escapeTelegramHtml, opsNotice } from "../../src/shared/opsAlertGrammar";

const hook = readFileSync(join(REPO_ROOT, "deploy", "herald-notify-failure.sh"), "utf8");

describe("the two ops senders agree on one grammar", () => {
  it("both ask Telegram for HTML, and neither for MarkdownV2", () => {
    expect(hook).toContain('"parse_mode":"%s"');
    expect(hook).toContain('send_telegram "$TEXT" "HTML"');
    expect(hook).not.toMatch(/MarkdownV2/);
  });

  it("both escape exactly &, < and >, ampersand first", () => {
    const bashOrder = /s=\$\{s\/\/&\/&amp;\}[\s\S]*?s=\$\{s\/\/<\/&lt;\}[\s\S]*?s=\$\{s\/\/>\/&gt;\}/;
    expect(bashOrder.test(hook), "html_escape must replace & before < and >").toBe(true);
    expect(escapeTelegramHtml("400 <a> & <b>")).toBe("400 &lt;a&gt; &amp; &lt;b&gt;");
  });

  it("both wrap the detail block in <pre> and lead the pointer with ↳", () => {
    expect(hook).toContain("<pre>");
    expect(hook).toContain("↳ ");
    const notice = opsNotice({ icon: "ℹ", title: "x-reconcile — 번역 2건 은퇴", lines: ["x:1", "x:2"] });
    expect(notice).toContain("<pre>x:1\nx:2</pre>");
    expect(notice.startsWith("ℹ ")).toBe(true);
  });

  it("escapes the title too, not just the lines", () => {
    const notice = opsNotice({ icon: "⚠", title: "a <b> & c", lines: ["<d>"] });
    expect(notice).toContain("a &lt;b&gt; &amp; c");
    expect(notice).toContain("<pre>&lt;d&gt;</pre>");
    expect(notice).not.toContain("<b>");
  });

  it("omits the block entirely when there are no lines", () => {
    expect(opsNotice({ icon: "ℹ", title: "그냥 한 줄" })).toBe("ℹ 그냥 한 줄");
  });
});
```

Add to `tests/shared/notifyOps.test.ts`:

```ts
  it("sends HTML and retries once as plain text when Telegram rejects it", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID_OPS = "c";
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 400 } as Response;
    }) as unknown as typeof fetch;

    await notifyOps("ℹ t\n<pre>a &lt;b&gt;</pre>", fetchFn);

    expect(calls).toHaveLength(2);
    expect(calls[0].parse_mode).toBe("HTML");
    expect(calls[1].parse_mode).toBeUndefined();
    expect(String(calls[1].text)).not.toContain("<pre>");
    expect(String(calls[1].text)).toContain("a <b>");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/deploy/opsAlertGrammar.test.ts tests/shared/notifyOps.test.ts`
Expected: FAIL — `src/shared/opsAlertGrammar.ts` does not exist; `notifyOps` sends no `parse_mode` and never retries.

- [ ] **Step 3: Write the implementation**

Create `src/shared/opsAlertGrammar.ts`:

```ts
/**
 * The shape every ops-room message takes, on both sides of a language boundary.
 *
 * `deploy/herald-notify-failure.sh` is bash and this is TypeScript; they cannot share code, only a
 * grammar. Until now they shared only a resemblance — notifyOps's own header says it "deliberately
 * mirrors that script's env contract" — and a resemblance nothing checks is one that drifts until
 * an operator cannot tell which sender is talking. `tests/deploy/opsAlertGrammar.test.ts` reads both
 * files and pins them equal, the same two-files-one-decision coupling `src/deploy/alertMarker.ts`
 * already keeps with the same script.
 *
 * The grammar:
 *
 *     <icon> <title>            plain — must stay readable on a narrow phone
 *     <pre>line
 *     line</pre>                monospace — the reports these commands print are column-aligned
 *     ↳ <pointer>               where to read the rest (failure alerts only)
 */

/**
 * For `parse_mode: "HTML"`, which needs only these three — the reason the repo chose HTML over
 * MarkdownV2, whose 18 characters include `.`, `(`, `)` and `-`
 * (`src/domain/formatting/emitters/telegram.ts`).
 *
 * `&` first, or the ampersands this introduces are escaped again and the reader sees `&amp;lt;`.
 */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function opsNotice(opts: { icon: "ℹ" | "⚠"; title: string; lines?: string[] }): string {
  const head = `${opts.icon} ${escapeTelegramHtml(opts.title)}`;
  if (!opts.lines || opts.lines.length === 0) return head;
  return `${head}\n<pre>${opts.lines.map(escapeTelegramHtml).join("\n")}</pre>`;
}
```

In `src/shared/notifyOps.ts`, replace the single `fetchFn` call with an HTML attempt and one plain retry:

```ts
  // One attempt as HTML, one as plain text if Telegram rejects it. Same posture as
  // deploy/herald-notify-failure.sh: a formatting mistake must cost this message its formatting,
  // not the message. One retry, not a loop — the plain form is the encoding that worked before
  // HTML existed here, so a second failure is not about formatting.
  const post = async (body: Record<string, unknown>): Promise<Response> =>
    fetchFn(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });

  try {
    let res = await post({ text, parse_mode: "HTML" });
    if (!res.ok) {
      const plain = text
        .replace(/<\/?pre>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      res = await post({ text: plain });
    }
    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
    }
    console.log(`[notifyOps] sent to ops chat ${chatId}`);
  } catch (err) {
    console.error(`[notifyOps] failed to notify: ${(err as Error).message}`);
  }
```

In `src/cli/xReconcileReport.ts:128`, replace the one-line return with the shared grammar. The current line is:

```ts
  return `x:reconcile retired ${retiredCount} translation(s) already posted by hand on @${handle}: ${retiredItemIds.join(", ")}`;
```

Replace it with:

```ts
  // The IDs were a comma-run in one paragraph — 14 of them in a real 2026-08-07 alert, unreadable
  // on a phone. One per line inside the shared <pre> block instead.
  return opsNotice({
    icon: "ℹ",
    title: `x:reconcile — 손으로 이미 올라가 있던 번역 ${retiredCount}건 은퇴 (@${handle})`,
    lines: retiredItemIds,
  });
```

and add `import { opsNotice } from "../shared/opsAlertGrammar";` at the top.

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: green. `tests/cli/xReconcileReport.test.ts` asserts the old English sentence; update those assertions to the new grammar rather than deleting them — they are what stops the notice regressing to a comma-run.

- [ ] **Step 5: Commit**

```bash
git add src/shared/opsAlertGrammar.ts src/shared/notifyOps.ts src/cli/xReconcileReport.ts \
        tests/deploy/opsAlertGrammar.test.ts tests/shared/notifyOps.test.ts tests/cli/xReconcileReport.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "feat(alerts): give both ops senders one grammar and pin them equal"
```

---

### Task 4: `creds:check`'s refusals say why

**Files:**
- Modify: `src/cli/creds-check.ts:33-76`
- Test: `tests/cli/credsCheck.test.ts`

**Interfaces:**
- Consumes: `ALERT_MARKER` from `src/deploy/alertMarker.ts`, already imported in that file for `failedLine()`.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

```ts
  it.each([
    ["no origin anywhere", [] as string[], {}, "HERALD_DEPLOYMENT_ORIGIN"],
    ["a malformed URL", ["not a url"], {}, "not a url"],
    ["a non-http scheme", ["ftp://example.com"], {}, "ftp://example.com"],
  ])("marks the refusal so the alert can carry it: %s", async (_name, args, env, needle) => {
    // A real 2026-08-10 alert for an exit-2 run carried the wrapper footer and four systemd lines,
    // and nowhere in it the reason. failedLine() fires only for failed CHECKS, so these paths
    // printed nothing marked and the alert had nothing to promote.
    const r = await run({ HERALD_DEPLOYMENT_ORIGIN: undefined, ...env }, args);
    expect(r.status).toBe(2);
    const marked = (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith(ALERT_MARKER));
    expect(marked, "exactly one marked line").toHaveLength(1);
    expect(marked[0]).toContain(needle);
  });

  it("marks the refusal when HERALD_SMOKE_* is unset", async () => {
    const r = await run({ HERALD_SMOKE_USERNAME: undefined, HERALD_SMOKE_PASSWORD: undefined });
    expect(r.status).toBe(2);
    const marked = (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith(ALERT_MARKER));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("HERALD_SMOKE_USERNAME");
  });
```

Import `ALERT_MARKER` at the top of the test file if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/credsCheck.test.ts`
Expected: FAIL — zero marked lines on every refusal path.

- [ ] **Step 3: Write the implementation**

In `src/cli/creds-check.ts`, add above the first refusal:

```ts
/**
 * A configuration refusal, marked so `deploy/herald-notify-failure.sh` promotes it into the alert.
 *
 * Without this the operator got the 2026-08-10 message: a wrapper footer, four systemd lines, and
 * no reason anywhere. `failedLine()` covers a failed *check*; exit 2 is not a failed check, and it
 * is the case where the alert most needs to say what happened — a credential failure at least names
 * a credential, while `status=2/INVALIDARGUMENT` names nothing.
 *
 * On stdout, not stderr: the wrapper tees both into the run log, but the marker scan reads lines in
 * the order they were written and stdout is what the report uses.
 */
function refuse(message: string): never {
  console.error(message);
  console.log(`${ALERT_MARKER}✗ ${message}`);
  process.exit(2);
}
```

Then replace each of the four `console.error(…); process.exit(2);` pairs at lines 35-36, 43-44, 56-57 and 71-76 with a single `refuse(…)` call carrying the same message text. Keep the messages exactly as they are — they were reviewed for not leaking a credential.

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: green. Existing refusal tests assert on `r.stderr`; the message is still on stderr, so they should be untouched. If one now fails, the message text changed and that is a mistake.

- [ ] **Step 5: Verify the whole path end to end**

Drive the real wrapper and a `curl`-stubbed copy of the real hook with a `creds:check` exit-2 run, and paste the operator-facing message into your report. The assertion is that the reason — `Not an http(s) URL: …` — appears in it. This is the message from Kyle's own 2026-08-10 paste, and the task is not done until that paste would read differently.

- [ ] **Step 6: Commit**

```bash
git add src/cli/creds-check.ts tests/cli/credsCheck.test.ts
git -c user.name='kyle-park-io' -c user.email='andy3638@naver.com' \
  commit -m "fix(deploy): make creds:check's refusals reach the alert"
```

---

## Self-Review

**Spec coverage.** "Prefer the durable run log" → Task 1. "One grammar, two senders" → Tasks 2 and 3, with the cross-sender test in Task 3. "`<pre>` for the excerpt" → Task 2. "Escape `&`, `<`, `>`" and "retry once as plain text" → Task 2 for bash, Task 3 for TypeScript. "The header should carry the exit code" → Task 2. "`creds:check`'s exit-2 refusals emit no marked line" → Task 4. The spec's "What this does not change" list needs no task, and is restated in Global Constraints so no task quietly retunes those numbers.

**A rename the spec did not anticipate, resolved in Task 1.** Inverting the source preference makes `ALERT_FROM_JOURNAL` a wrong name for a three-valued fact, and the marked-line scan reads it. Task 1 replaces it with `EXCERPT_SOURCE` and says to repoint every use, because leaving a boolean named "from journal" that is false on the common path is how the next reader misreads the scoping block.

**Existing tests will break, and that is stated as work rather than left as a surprise.** Task 1 breaks `notifyFailureMarker.test.ts` tests that set only `STUB_JOURNAL_OUTPUT`; Task 2 breaks anything matching the old header or `— <pointer>`; Task 3 breaks `xReconcileReport.test.ts`'s English sentence. Each task says to update them to the new intent and forbids weakening an assertion to make it pass.

**Types.** `escapeTelegramHtml(s: string): string` and `opsNotice({ icon, title, lines? }): string` are defined in Task 3 and used only there and in `xReconcileReport.ts`. `ALERT_MARKER` is the existing export from `src/deploy/alertMarker.ts`, used unchanged in Task 4. `EXCERPT_SOURCE` is a bash variable with values `runlog` | `journal` | `none`, produced in Task 1 and read in Task 2.

**Placeholders:** none — every step carries the code or the command it needs.
