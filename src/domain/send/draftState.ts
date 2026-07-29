/**
 * The three shapes a Typefully draft lookup can answer with, once "not published yet" is no longer
 * conflated with "will never publish":
 *
 * - `published` — a real X url (and/or article url) exists; carries the parsed url/id pair(s) so a
 *   caller can rewrite a ledger row without a second round trip.
 * - `scheduled` — the draft still exists in Typefully's queue and simply has not gone out yet.
 * - `gone` — the draft was deleted (or never existed) and will never publish. Distinct from
 *   `scheduled` so a caller can stop waiting on a row instead of polling it forever.
 *
 * Lives here rather than next to the adapter that produces it: `ReconcilePublished` and friends
 * switch on this shape, and a use-case must not import from `src/adapters/*`.
 */
export type DraftState =
  | { state: "published"; xUrl?: string; xId?: string; articleUrl?: string; articleId?: string }
  | { state: "scheduled" }
  | { state: "gone" };
