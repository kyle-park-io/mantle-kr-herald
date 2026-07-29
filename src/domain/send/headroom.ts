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
