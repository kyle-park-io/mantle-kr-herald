# The ops alert should say what happened

Four scheduled units alert through `deploy/herald-notify-failure.sh`, and one command alerts through
`src/shared/notifyOps.ts`. Both send plain text to the same Telegram room. Here is one that arrived
on 2026-08-07, in full:

```
⚠ herald-x-reconcile.service failed
herald-x-reconcile.service: Main process exited, code=exited, status=1/FAILURE
herald-x-reconcile.service: Failed with result 'exit-code'.
Failed to start herald-x-reconcile.service - Mantle KR Herald X publish reconcile — one run of `pnpm x:reconcile --yes` against @0xMantleKR.
herald-x-reconcile.service: Triggering OnFailure= dependencies.
herald-x-reconcile.service: Consumed 2.021s CPU time.
— journalctl --user -u herald-x-reconcile.service -n 50 --no-pager
```

Six lines. Five of them are systemd talking about itself. The unit name appears five times. Nothing
says what `pnpm x:reconcile` did wrong.

Written 2026-08-10. Every claim below was read out of this repo or measured on this machine.

## Why the command's output never arrives

`herald-notify-failure.sh:119` reads the journal first and falls back to the durable run log only
when the journal comes back **empty**:

```sh
LOG_EXCERPT="$(journal_read --user -u "$UNIT" -n "$LOG_TAIL_LINES" --no-pager --output=cat)" || LOG_EXCERPT=""
```

journald attributes systemd's own messages about a unit to that unit. Those messages — `Main process
exited`, `Failed with result`, `Failed to start`, `Triggering OnFailure=`, `Consumed … CPU time` —
are emitted **after** the process exits, so they are always the last lines. `LOG_TAIL_LINES=5` then
spends the entire budget on them.

The journal is essentially never empty for a unit that just failed, so the run-log fallback almost
never fires. `deploy/herald-run-logged.sh` has been writing a per-run log for every scheduled run,
containing exactly the command's own output, and the alert has been ignoring it.

The same file's own comment already names the contract this breaks:

> Five lines is a phone-readable budget, and it is a CONTRACT with the commands these units run […]
> a command whose important output is not in its last five lines does not appear in the alert at all.

The commands hold up their end. The hook does not read what they wrote.

## What changes

### Prefer the durable run log

Read `~/.herald/logs/<unit>/<newest>.log` first; use the journal only when there is no run log. The
run log is the command's own output and the wrapper's two boundary lines, with no systemd noise in
it at all.

This also retires a problem rather than managing it. The journal is one continuous stream per unit,
which is why the marked-line scan needed `awk` anchoring at the last `=== <unit> started …` line to
avoid promoting a previous day's failure. A run log is one run by definition. The `awk` scoping
stays for the journal fallback, where it is still needed, and stops being load-bearing on the path
that actually runs.

### One grammar, two senders

`herald-notify-failure.sh` is bash and `notifyOps` is TypeScript; they cannot share code. They can
share a grammar, and today they share only a resemblance — `notifyOps`'s own header says it
"deliberately mirrors that script's env contract". A resemblance nothing checks drifts.

```
⚠ <unit> 실패 (exit <n>)          header — plain text, never truncated
✗ FAILED: <what>                  marked lines — what the command declared must arrive
<pre>…excerpt…</pre>              monospace, HTML-escaped
↳ <pointer>                       where to read the rest
```

`notifyOps` sends the same shape for something that is not a failure:

```
ℹ x-reconcile — 손으로 올려있던 번역 14건 은퇴 (@0xMantleKR)
<pre>x:2082820449365626980
x:2082855380200329251
…외 12건</pre>
```

Korean chrome, log content verbatim. The documentation is Korean (`docs/ko/`), the reader is the
operator, and the log lines are English because the programs that wrote them are.

One test reads both senders and asserts they agree on the grammar.

### `<pre>` for the excerpt

The reports these units print are column-aligned:

```
  ✓ live: google_drive_review    review folder reachable
  ✗ live: google_auth            Google refused the refresh token: 400 invalid_grant
```

Proportional text collapses that into ragged lines and wraps one entry across two. `<pre>` keeps it
readable at the cost of horizontal scrolling on a narrow phone, and lets the operator copy the
excerpt out unchanged. The repo already settled the parse mode question — `HTML`, never MarkdownV2,
"which requires escaping 18 characters" (`src/domain/formatting/emitters/telegram.ts:29`).

## The risk this introduces, and the guard for it

Turning on `parse_mode: "HTML"` makes the alert **rejectable**. A log line containing `<` or `&`
produces malformed HTML, Telegram answers 400, and `curl -fsS`'s failure is already swallowed by
`|| true` — so the alert disappears silently. Today, with plain text, no log content can do that.

Two mitigations, both required:

1. **Escape `&`, `<`, `>`** in every value interpolated into the message — the header's unit name,
   the marked lines, the excerpt, the pointer. The `<pre>` tags themselves are ours and stay literal.
2. **Retry once as plain text on a rejection.** On a non-2xx from Telegram, send the same message
   again with no `parse_mode` and with the `<pre>` tags stripped, so the operator gets the content
   unformatted rather than nothing. One retry, not a loop: the second attempt uses the same encoding
   that works today, so if that fails too the problem is not the formatting.

   Escaping is a thing a future edit can get wrong in one place; the retry is what keeps a
   formatting bug from costing every alert. It also covers Telegram rejecting for a reason nobody
   predicted. Note what it is guarding: `curl -4 -fsS -m 10 … >/dev/null || true`
   (`herald-notify-failure.sh:397-401`) already discards the failure, so today a 400 is invisible
   from both ends.

The second matters more than the first. This project's recurring failure is a check that looks
installed and never runs; an alert path that a stray `<` silently disables is the same shape.

Escaping composes with the control-character sanitizing already in `sanitizeWireText`
(`src/deploy/describeValue.ts`) rather than replacing it: that one stops a wire string forging a
`HERALD_ALERT:` line, this one stops it forging markup.

## Two smaller things the same work fixes

**The header should carry the exit code.** `systemctl --user show <unit> -p ExecMainStatus --value`
gives it, and the wrapper's `=== <unit> exited <n> at … ===` footer is the fallback when that is
unavailable. `exit 2` and `exit 1` mean different things here — configuration error versus a dead
credential — and the operator currently has to infer which from the body.

**`creds:check`'s exit-2 refusals emit no marked line.** This alert arrived on 2026-08-10:

```
⚠ herald-creds.service failed
=== herald-creds.service exited 2 at 2026-08-10T10:03:18Z ===
herald-creds.service: Main process exited, code=exited, status=2/INVALIDARGUMENT
…
```

The actual reason — `Not an http(s) URL: ftp://…` — is nowhere in it. `failedLine()` fires only for
failed *checks*, so the refusal paths at `src/cli/creds-check.ts` print nothing marked. They should.

## Testing

- The new shape driven end to end for all four units, on both branches (run log, journal fallback),
  through the real wrapper and a `curl` stub — the rig `tests/deploy/notifyFailureMarker.test.ts`
  already establishes.
- HTML escaping against hostile log content: `<`, `&`, `>`, a line that is entirely markup, and a
  `</pre>` inside a log line.
- The 4xx retry **fired for real** against a stub that rejects the HTML attempt and accepts the
  plain one. A retry nobody has watched execute is the thing this spec exists to prevent.
- Both senders read by one test and asserted to agree on the grammar.
- `notifyOps`'s existing callers keep working: `x:reconcile`'s retire notice is the only one today.

## What this does not change

The five-line budget, the `HERALD_ALERT:` marker mechanism, the two `journalctl` timeouts, the byte
cap on the scan window, and the run-log fallback's existence. Those were settled on 2026-08-10 and
this spec reuses them. What changes is which source is consulted first, and how the result is
dressed.

It also does not add a success notification for `creds:check`. The hook is `OnFailure=` only, and
the next morning's silence already carries "nothing died" — the same argument the credential-probe
spec makes for not adding a recovery notice.
