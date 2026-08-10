/**
 * The one line of a scheduled run's output that must reach the operator's phone, marked as such.
 *
 * **Why a marker and not a position.** `deploy/herald-notify-failure.sh` builds its Telegram message
 * from the last `LOG_TAIL_LINES` (5) lines of the failing unit's output. That is a positional
 * heuristic, and it lost: `creds:check`'s report ends with a blank line and the counts, so with
 * seven probes the `✗` naming the dead credential sat nine rows from the end and never reached the
 * alert — the operator got two green ticks and `6 ok · 0 warn · 1 fail`. Printing the summary last
 * fixed that run, and left the fix one line of slack: on the journal branch systemd's own
 * `Main process exited` / `Failed with result` / `Failed to start` lines put it at position 1 of 5,
 * so one more systemd line (`Consumed 1.234s CPU time` is a real one), one stray `console.log`, or
 * one edit to `LOG_TAIL_LINES` empties the alert of its only useful content again — silently, and
 * with the same symptom as everything working.
 *
 * So the content declares itself instead of being located. A line printed with this prefix is
 * carried into the alert **regardless of tail depth**, and the hook strips the prefix before
 * sending, so the marker costs the message nothing.
 *
 * **This string is a contract with a bash script**, which cannot import it:
 * `deploy/herald-notify-failure.sh` matches it with `grep` at the start of a line, and
 * `tests/deploy/notifyFailureMarker.test.ts` pins the two spellings equal — the same
 * two-files-one-decision coupling `tests/deploy/runLogging.test.ts` already keeps between the
 * wrapper's log root and the hook's.
 *
 * Chosen to be something no scheduled command produces by accident: the other three units pipe
 * `claude -p` output through the same log, and a marker they could emit by chance would change
 * their alerts. Uppercase, underscored, anchored at column 0, and followed by a space.
 */
export const ALERT_MARKER = "HERALD_ALERT: ";
