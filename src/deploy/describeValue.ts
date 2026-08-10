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
