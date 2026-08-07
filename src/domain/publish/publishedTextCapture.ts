/**
 * Decide which translations should have their `publishedText` cell filled in, and with what.
 *
 * A reconcile run already knows, for a settled translation, which live thread it matched
 * (`postedUrl`) or, for one it just retired this run, which thread it was retired against
 * (`posted`). Either way the live thread's own words are sitting right there in `threads` — this
 * is the pure rule that reads them back into a shape a caller can write to Postgres, without ever
 * touching a database itself.
 *
 * Pure domain: no clock, no environment, no I/O. Same inputs, same captures, every time.
 */

import { threadText, parsePostUrl } from "./xReconcile";
import type { AssembledThread } from "../models";
import type { Translation } from "../translation/models";

/** One published body to write: `text` goes into `itemId`'s `publishedText` cell for `rootId`'s thread. */
export interface PublishedTextCapture {
  itemId: string;
  rootId: string;
  text: string;
}

/**
 * `capturePublishedTexts`'s full input. `translations` and `posted` are independent views a
 * reconcile run already produces for other reasons — this function does not merge or validate
 * them against each other beyond what each capture needs.
 */
export interface CapturePublishedTextsInput {
  translations: Translation[];
  threads: AssembledThread[];
  /** This run's fresh retires: itemIds matched against a live thread just now, by rootId. */
  posted: { itemId: string; rootId: string }[];
  /** The account this run is pointed at. Compared case-insensitively, same as `settledTranslationDisposition`. */
  handle: string;
}

/**
 * Fill `publishedText` for every translation whose live post this run can read back, skipping
 * anything already filled, unmatched, or unattributable to `handle`'s account.
 *
 * The rootId comes from two places, and `posted` wins when both are present. `posted` is this
 * run's own fresh match, made moments ago against the same `threads` this function reads; a
 * `postedUrl` is a stored value from a *previous* run and may point at a thread that has since
 * aged out of `--since` or, in a hand-edited row, at the wrong post entirely. Preferring the
 * fresher, self-consistent source over the older, borrowed one is the same call
 * `settledTranslationDisposition` makes when it lets this run's own output take precedence over a
 * stored record (see its `settledRootIds` handling in `xReconcile.ts`).
 *
 * Reuses `threadText` for the thread body and `parsePostUrl` for the url, rather than re-deriving
 * either: `threadText` is the exact join `classify`/`bestThreadFor` score against, and a second
 * joining rule here would risk storing a body that reads differently from the one a human's
 * confirmation was actually based on. `parsePostUrl` already narrows a url to a candidate
 * `(handle, rootId)` pair and returns `undefined` for anything malformed — this function skips
 * those rather than guessing, the same refusal `settledTranslationDisposition` makes for a
 * `postedUrl` that fails its own round-trip check.
 *
 * Output order follows `translations` order and holds at most one capture per itemId, so a
 * caller's printed list is stable across runs.
 */
export function capturePublishedTexts(input: CapturePublishedTextsInput): PublishedTextCapture[] {
  const { translations, threads, posted, handle } = input;

  const threadByRootId = new Map(threads.map((thread) => [thread.rootId, thread]));
  const postedRootIdByItemId = new Map(posted.map((entry) => [entry.itemId, entry.rootId]));

  const captures: PublishedTextCapture[] = [];
  const seenItemIds = new Set<string>();

  for (const translation of translations) {
    const { itemId, postedUrl, publishedText } = translation;

    // Already filled — never overwrite a cell that has a value, including an already-captured
    // duplicate itemId within this same call.
    if (publishedText !== undefined && publishedText !== "") continue;
    if (seenItemIds.has(itemId)) continue;

    // `posted` is this run's fresh match and is authoritative over a stored `postedUrl` (see
    // this function's own doc comment for why).
    const freshRootId = postedRootIdByItemId.get(itemId);
    let rootId: string | undefined = freshRootId;

    if (rootId === undefined) {
      if (postedUrl === undefined) continue;
      const parsed = parsePostUrl(postedUrl);
      if (parsed === undefined) continue; // malformed url — skip, never guess
      if (parsed.handle.toLowerCase() !== handle.toLowerCase()) continue; // not this run's account
      rootId = parsed.rootId;
    }

    const thread = threadByRootId.get(rootId);
    if (thread === undefined) continue; // aged out of this run's pool; a later, wider run fills it

    seenItemIds.add(itemId);
    captures.push({ itemId, rootId, text: threadText(thread) });
  }

  return captures;
}
