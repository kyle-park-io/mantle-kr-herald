import { contentHash, isStale, type SyncEntry } from "../domain/publish/syncLedger";

/**
 * Three mutually-exclusive states per item, relative to its CURRENT status:
 * - `synced`         — every ledger row is at the current status and matches the current render.
 * - `needsRepublish` — the item was published, but the live files are outdated: a status change
 *                      (published as review, then approved) or an edit since the last upload.
 * - `unpublished`    — no ledger row at all.
 *
 * Counted over the items the Drive path still applies to, which is every item except a `posted` one
 * — see `syncSummary` for why those are excluded rather than bucketed.
 */
export interface SyncCounts {
  synced: number;
  needsRepublish: number;
  unpublished: number;
}

interface Publishable {
  itemId: string;
  status: string;
}

/**
 * `render` produces exactly the bytes the uploader would send, so the hash comparison detects
 * "approved, then edited, but Drive still holds the old version" as well as a plain status change.
 *
 * **A `posted` item is not counted at all.** It is terminal for the Drive path (`PublishTranslations`
 * skips it, and the dashboard's 발행 buttons and the publish route both refuse it), so neither of the
 * two things this summary can say about it is true or actionable. `needsRepublish` would be a
 * standing lie: an approved item that reconcile retires to `posted` has a perfectly good approved doc
 * in Drive, but its ledger row's status no longer equals the item's status, so the row-vs-status
 * comparison below flags it forever, the dashboard lights ⚠, and `TranslationDetail` tells the
 * reviewer to press 발행 again — which, before this fix, would have uploaded it to `review/` and
 * deleted the approved doc. `unpublished` would be the same standing lie for a `posted` item that
 * never went to Drive: an alarm about work that is now impossible to do. Excluding it says the only
 * honest thing, which is nothing.
 *
 * Scoped to `posted` alone, and expressed as "skip this status" rather than "skip anything with no
 * remaining action": a genuinely stale `approved` item must still be reported, because pressing 발행
 * really is the fix for that one.
 */
export function syncSummary<T extends Publishable>(input: {
  translations: T[];
  entries: SyncEntry[];
  render: (t: T) => string;
}): SyncCounts {
  let synced = 0;
  let needsRepublish = 0;
  let unpublished = 0;

  for (const t of input.translations) {
    if (t.status === "posted") continue; // terminal for the Drive path — see the doc comment above
    const mine = input.entries.filter((e) => e.itemId === t.itemId);
    if (mine.length === 0) {
      unpublished += 1;
      continue;
    }
    const current = contentHash(input.render(t));
    // Synced only when NOTHING is out of date: every row is at the current status and current hash.
    // A wrong-status leftover (e.g. the review doc after approval) or a stale hash flips it.
    const fullySynced = mine.every((e) => e.status === t.status && !isStale(e, current));
    if (fullySynced) synced += 1;
    else needsRepublish += 1;
  }

  return { synced, needsRepublish, unpublished };
}

export function formatSyncSummary(s: SyncCounts): string {
  const parts = [`${s.synced} synced`];
  if (s.needsRepublish > 0) parts.push(`${s.needsRepublish} need republish`);
  if (s.unpublished > 0) parts.push(`${s.unpublished} unpublished`);
  const warn = s.needsRepublish > 0 || s.unpublished > 0 ? "⚠ " : "";
  return `${warn}sync: ${parts.join(" · ")}`;
}
