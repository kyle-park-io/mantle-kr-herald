/**
 * Collapse any run of whitespace — including newlines — into single spaces, trim, and cap the
 * length, appending `…` when anything was dropped.
 *
 * Written for `pnpm watch`'s failure path, where a detail string does not stay a string: it is
 * printed as one `console.log` line, journald records it, and
 * `deploy/herald-notify-failure.sh` then reads that journal back with `journalctl -n 5` and keeps
 * only the last 500 characters of what it finds. A multi-line stack trace in the detail therefore
 * becomes five *separate* journal lines, of which the hook keeps the tail — so the Telegram alert
 * shows the middle of someone's stack trace with the `watch: FAILED — <stage>:` prefix, the one
 * part that says what actually broke, already scrolled off the top. Collapsing to a single line
 * keeps the whole message inside one journal entry; the cap keeps that entry inside the hook's
 * 500-character budget so the prefix survives the tail-slice too.
 */
export function condense(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}
