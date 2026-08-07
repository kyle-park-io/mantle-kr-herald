/**
 * The `history` tab's two identities for an already-recorded X post, read once and shared.
 *
 * Extracted from `x-reconcile.ts` when `x:link` needed the same read: `RetireTranslation` takes
 * `historyPostIds` as its guard against writing a second history row for one post, so both entry
 * points have to compute it the same way. A second copy of the range, the column indices and the
 * HTTP-400 handling below is exactly the kind of duplicate that misdescribes reality the first time
 * one of the two moves.
 */
import type { SheetClient } from "../ports/SheetClient";

// A–D: itemId, type, channel, postId (see HISTORY_HEADER). Columns E–J are RecordPublish's and
// RecordImpressions' to own; nothing here writes them and nothing here needs to read them.
const HISTORY_KEYS_RANGE = "history!A2:D";

/**
 * The `history` tab read as the two identities an already-recorded X post can carry: the `itemId` in
 * column A and the `postId` in column D.
 *
 * Both are needed, and column A alone was a bug. `kr:<rootId>` in column A only ever matches a row
 * this reconcile itself wrote. The tab's real identity for an X row is the postId — that is what
 * `RecordImpressions` filters and fetches on — and the same live post can already sit there under a
 * different itemId: `pnpm history:record --item x:… --post-id …` is the documented manual path for
 * exactly these hand-posted threads, and a `send:channels` send whose rendering later stopped being an
 * eligible candidate leaves one too. Keyed on column A alone, such a post gained a *second* row and
 * `impressions:record` wrote view counts into both.
 *
 * A workbook that has never had a row written to it — or one where `history:record`/`send:channels`
 * never ran at all — has no `history` tab, and the raw Sheets error for that is `HTTP 400`. That must
 * read as "nothing recorded yet", not a crash: same handling `LoadKolMap.readTab` gives the `kol-map`
 * tab's own first-run-before-anyone-created-it case.
 */
export async function loadHistoryKeys(sheet: SheetClient): Promise<{ itemIds: Set<string>; postIds: Set<string> }> {
  try {
    const rows = await sheet.getValues(HISTORY_KEYS_RANGE);
    return {
      itemIds: new Set(rows.map((r) => r[0]).filter((v): v is string => Boolean(v))),
      postIds: new Set(rows.map((r) => r[3]).filter((v): v is string => Boolean(v))),
    };
  } catch (err) {
    const message = (err as Error)?.message ?? "";
    if (/HTTP 400/.test(message)) return { itemIds: new Set(), postIds: new Set() };
    throw err;
  }
}

/** Just the postIds — what `RetireTranslation` needs, for a caller that has no use for column A. */
export async function loadHistoryPostIds(sheet: SheetClient): Promise<Set<string>> {
  return (await loadHistoryKeys(sheet)).postIds;
}
