/**
 * A short, safe rendering of a value that came off the wire, for putting inside a
 * `CheckResult.detail`.
 *
 * This exists because `JSON.stringify` is neither of those things, and both halves were found by
 * running it rather than by reading it.
 *
 * **It throws.** `JSON.parse` is iterative and accepts nesting 100,000 deep without complaint;
 * `JSON.stringify` is recursive and dies with `RangeError: Maximum call stack size exceeded`
 * somewhere between depth 3,000 and 5,000 on this runtime (measured: 3,000 fine, 5,000 throws). So
 * every `JSON.stringify(body)` sitting inside a *judging* function — the functions whose entire
 * contract is "total over an unvalidated HTTP body, never throws" — was a body the deployment could
 * send to make them throw after all. Reproduced end-to-end against the real `creds:check`: a
 * `probes` value nested 5,000 deep and a `sendsEnabled` nested 5,000 deep each ended the run at
 * `✗ credential liveness … Maximum call stack size exceeded`, with the entire liveness report
 * discarded — `0 ok · 0 warn · 1 fail` for a deployment whose six other probes were fine. A non-zero
 * exit whose message does not say what failed is the thing this feature exists to remove, so the fix
 * belongs here, at the description, not in a `catch` further out that renames the symptom.
 *
 * **It is unbounded.** A 20,000-character body went into a detail line in full, and
 * `herald-run-logged.sh` tees stdout into `~/.herald/logs/<unit>/<run>.log` with no cap. The
 * Telegram hop is capped at 500 characters by `herald-notify-failure.sh`, so nothing overruns a
 * message — but the durable log grows without limit, and the right place to bound a string is where
 * it is built, not at each thing that might later send it.
 *
 * Output is byte-identical to `JSON.stringify` for every value small enough to belong in a report
 * line, which is what makes this a safe drop-in at the existing call sites.
 */

/** Long enough to recognise a body at a glance, short enough that a log line stays a log line. */
export const MAX_DESCRIBED_LENGTH = 200;

/**
 * A wire string made safe to put on a report line, by escaping every control character rather than
 * dropping it.
 *
 * `describeValue` renders through `JSON.stringify`, which already escapes these. A string that
 * reaches a report line **without** going through it does not: `checkLiveness` interpolates a
 * probe's `key` and `detail` straight into `name`/`detail`, and a deployment answering with
 * `{"key": "google_auth\nSOMETHING", …}` turned one report line into two. That is not only an
 * adversarial case — `parseProbe`'s own comment accepts an unknown key precisely because a
 * deployment can be "one probe ahead of this build", so the key is whatever that build sends.
 *
 * Two things break when a wire string can contain a newline, and the second is why this is not
 * cosmetic:
 *   - `creds:check`'s `✗ FAILED:` summary is a one-line guarantee. One embedded newline made it
 *     three physical lines, and the tail that carries it into a Telegram alert counts lines.
 *   - `deploy/herald-notify-failure.sh` selects lines to force into that alert by matching a marker
 *     at the start of a line. A wire string carrying `\nHERALD_ALERT: …` would inject one.
 * A terminal escape is the third: an ESC-[-2-J sequence in a probe key clears the screen of
 * whoever cats the run log.
 *
 * Escaped, not stripped, so the evidence survives — `google_auth\x0aSOMETHING` says what arrived.
 * Bounded by construction: each control character becomes exactly four characters, and every caller
 * is length-capped downstream anyway.
 */
export function sanitizeWireText(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 (which is \n, \r, \t and ESC), DEL, and C1 — the last because a lone 0x9b is an
    // alternative CSI introducer on some terminals, so escaping only C0 leaves a working escape.
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

export function describeValue(value: unknown, maxLength: number = MAX_DESCRIBED_LENGTH): string {
  const text = render(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… (truncated from ${text.length} characters)`;
}

/**
 * `JSON.stringify` where it works, a description of the value's shape where it does not. Deliberately
 * never re-raises and never quotes the underlying error: `Maximum call stack size exceeded` in an
 * operator's Telegram alert describes this process's stack, not their deployment, and is exactly the
 * misreported cause this helper exists to prevent.
 */
function render(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    // `undefined` for `undefined`, functions and symbols — not a failure, just not JSON.
    if (json !== undefined) return json;
  } catch {
    // Deep nesting (RangeError), a circular structure or a BigInt (TypeError), or a `toJSON` that
    // throws. All four are things a body can be, so all four are described rather than thrown.
  }
  try {
    return shapeOf(value);
  } catch {
    // `shapeOf` itself reads `.length` and `Object.keys`, which an exotic object (a Proxy with a
    // throwing trap) can still refuse. There is nothing left to say about such a value except that.
    return "(a value that could not be described)";
  }
}

/** What a value IS, computed without recursing into it — the part that stays true when the value is
 *  too deep to serialise. Names a few keys because "which fields did it have" is the first question
 *  an operator asks of a payload that did not parse into the expected shape. */
function shapeOf(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "(a function)";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) {
    return `(an array of ${value.length} entries, too deeply nested or otherwise not renderable as JSON)`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const named = keys.slice(0, 5).join(", ");
    const ellipsis = keys.length > 5 ? ", …" : "";
    const listed = named === "" ? "" : ` (${named}${ellipsis})`;
    return `(an object with ${keys.length} keys${listed}, too deeply nested or otherwise not renderable as JSON)`;
  }
  return `(a ${typeof value} that could not be rendered as JSON)`;
}
