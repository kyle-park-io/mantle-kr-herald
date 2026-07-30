/**
 * Pure data describing how much Typefully publishing headroom is left. Zero dependencies, so it
 * lives in the domain: `src/cli/publishHeadroom.ts` composes a ledger port, `loadTypefullyConfig`
 * and the `TypefullyQuota` adapter into the readers that produce this shape — that composition is
 * composition-root work and belongs in `cli/`, but the shape itself does not.
 */
export interface Headroom {
  /** The account's raw remaining publishes, for display. */
  remaining: number;
  /** Publishes already spent — the banner's denominator is `used + remaining`. */
  used: number;
  /** Scheduled but unconfirmed sends, across BOTH ledgers (x-post rooms and x-article). */
  inFlight: number;
  /**
   * `remaining − inFlight`. Deliberately NOT clamped at zero: a stale in-flight row can overcount and
   * drive this negative, and clamping here would silently turn "we are over-committed" into "we are
   * exactly at zero" for the gate that compares against it. Callers clamp only when they *display*
   * the number.
   */
  available: number;
  resetsAt: string;
}

export interface HeadroomView {
  headroom?: Headroom;
  error?: string;
}

/**
 * What a pair of headroom readings, taken either side of the resend guard's cancel, proves about
 * whether a publish was charged in between.
 *
 * - `published`   — a publish landed inside the window. The `204` was Typefully deleting the record
 *                   of a post that had already gone live, not cancelling a queued draft.
 * - `still`       — nothing was charged. The cancel really was a cancel.
 * - `reset`       — the counters went BACKWARDS, which only a monthly quota reset does. Proves
 *                   nothing either way; see below.
 * - `incoherent`  — the two readings cannot both describe the same account. Also proves nothing.
 * - `unreadable`  — one side could not be read at all.
 *
 * Only `still` is safe to proceed on. Everything else is the guard's standing rule: an unprovable
 * state is not evidence of safety, and the alternative to waiting is a second live post.
 */
export type PublishEvidence = "published" | "still" | "reset" | "incoherent" | "unreadable";

/**
 * Reads a publish out of two quota snapshots — the resend guard's only proof that a confirmed cancel
 * was not a publish beating it (Typefully answers `204` to both; measured live 2026-07-30).
 *
 * BOTH numbers are read, and that is the whole point of this function existing rather than a bare
 * `after.used > before.used` at the call site. `used` alone is not monotonic: the quota resets on
 * the 1st (KST), and a reset LOWERS it. A reset landing inside the guard's window turns `14 → 1`
 * into "used went down, so nothing published" — while that `1` is this very draft publishing right
 * after the rollover. That is the double post the guard exists to prevent, and it is reachable once
 * a month by clicking 재발송 at the wrong moment.
 *
 * A reset is therefore refused rather than reconciled, because it CANNOT be reconciled. `used +
 * remaining` is the plan's ceiling and is invariant across a reset as well as across a publish (a
 * publish just moves one to the other), so the pair cannot separate "reset, nothing published" from
 * "reset, and our draft published straight after". Nor can `after.used === 0` stand in for it: a
 * publish charged in the *old* month is wiped by the rollover, so a live post can sit behind a
 * counter reading zero. There is no arithmetic that recovers the answer — only a refusal that says
 * so. The operator pays one extra click, in a window a few seconds wide, once a month; the error it
 * replaces is irreversible and public.
 *
 * `resetsAt` is deliberately NOT consulted. It would tell the same story more cheaply on a correct
 * clock, and this machine's clock is measurably wrong — a guard that reads a rollover off a local
 * comparison would either refuse all month or never refuse. The counters moving backwards is the
 * account's own report that it rolled over, and it needs no clock to be true.
 *
 * That the two must move in OPPOSITE directions by the same amount (`dr === -du`) is the coherence
 * check: it is what makes `remaining` load-bearing rather than decorative. A `used` that rose while
 * `remaining` sat still, or moved with it, describes an account this arithmetic does not understand
 * — so it is refused rather than guessed at.
 */
export function publishEvidence(before: Headroom | undefined, after: Headroom | undefined): PublishEvidence {
  if (before === undefined || after === undefined) return "unreadable";
  const du = after.used - before.used;
  const dr = after.remaining - before.remaining;
  if (dr !== -du) return "incoherent";
  if (du > 0) return "published";
  if (du < 0) return "reset";
  return "still";
}
