import { extractMedia, countVideoMarkers, fillVideoMarkers } from "../domain/media/sourceMedia";
import { flattenXThreads } from "../adapters/content/XContentSource";
import type { CollectedThread } from "../domain/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { ConversionType } from "../domain/conversion/models";
import type { Translation } from "../domain/translation/models";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { FormattingStore } from "../ports/FormattingStore";
import type { TranslationStore } from "../ports/TranslationStore";

/**
 * The stored columns this command rewrites, spelled as the database spells them so a line of the
 * report can be grepped straight back to a column.
 *
 * `translations.published_text` is deliberately absent and must stay absent. It holds what the
 * account actually posted, read back off X by `x:reconcile`/`x:link`; 1차 검수 shows it under the
 * draft with the human's own edits highlighted. A marker rewritten there would show up as an edit
 * nobody made, against a text that has no second copy anywhere.
 */
export type TextColumn = "translations.source_text" | "translations.korean_text" | "renderings.text";

/** Why a text was left alone. Three reasons because they need three different remedies. */
export type TextSkipReason =
  /** No collected thread stands behind this item — a Lark item, or an `x_threads` row that is gone. */
  | { kind: "no-thread" }
  /** The text's `[영상]` markers and the thread's videos do not correspond one-to-one. */
  | { kind: "count-mismatch"; markers: number; videos: number }
  /** They correspond, but the thread's own video has no mp4 yet — `x:video-backfill` runs first. */
  | { kind: "url-missing"; missing: number };

export interface SkippedText {
  itemId: string;
  column: TextColumn;
  /** Set only for `renderings.text` — `(itemId, type, channel)` is the whole of a rendering's identity. */
  type?: ConversionType;
  channel?: Channel;
  /** Bare markers in this text, i.e. what was left unfilled. */
  bare: number;
  reason: TextSkipReason;
}

export interface TranslationTextPatch {
  /** The stored row with the filled text(s) — exactly what `apply` upserts, nothing else touched. */
  translation: Translation;
  /** Which of the row's two texts changed. Never `published_text`; see `TextColumn`. */
  columns: ("source_text" | "korean_text")[];
  /** Bare markers this row would gain a url for, across both columns. */
  filled: number;
}

export interface RenderingTextPatch {
  rendering: ChannelRendering;
  filled: number;
}

/**
 * What a run would do, computed before anything is written. `apply` writes exactly `translations`
 * and `renderings` and nothing else.
 *
 * The two are separate lists rather than one, because they are two different decisions for the
 * operator and the report has to say which is which: a `posted` translation gaining a url changes
 * only what the review screens display, while a `rendered` rendering gaining one changes what the
 * next `send:channels` actually uploads (`SendChannels` attaches
 * `videos.filter((url) => url !== "")`). Collapsing them into a single "12 rows would change" hides
 * the only distinction worth approving on.
 */
export interface TextVideoBackfillPlan {
  /** Stored texts carrying at least one bare `[영상]` — the denominator for everything below. */
  scanned: number;
  translations: TranslationTextPatch[];
  renderings: RenderingTextPatch[];
  /** Every text that carries a bare marker and was left untouched anyway, with its reason. */
  skipped: SkippedText[];
  /** Bare markers that would gain a url, across every row in both lists. */
  filled: number;
}

/**
 * The mp4 urls a stored text's `[영상]` markers stand for, in the order the markers were written,
 * keyed by item id.
 *
 * Derived by running the collected threads back through `flattenXThreads` — the very function that
 * wrote those markers — and reading the result with `extractMedia`, rather than walking
 * `thread.tweets[].media` directly. That is the point: the marker sequence is not the media
 * sequence. `flattenXThreads` drops nested commenter replies whole (42% of collected threads are
 * reply-only, and 140 nested reply blocks sat across 46 threads on 2026-08-07), and an X Article
 * tweet renders as markdown with no media markers at all. A hand-rolled walk of the media arrays
 * would count both, shift every pairing after them by one, and staple the wrong clip onto the post
 * — with no error and nothing downstream able to notice.
 *
 * `status` is forced to `active` on the way in, on purpose. `flattenXThreads` drops a deleted thread
 * because it is asking "what still belongs in the translation queue"; this asks "what do the markers
 * in an already-saved text mean", and a deleted thread's translation is still on the review screens.
 * (`BackfillVideoUrls` takes every status for the same reason.)
 */
function videoUrlsByItem(threads: Pick<CollectedThread, "rootId" | "tweets">[]): Map<string, string[]> {
  const items = flattenXThreads(
    threads.map((t) => ({ rootId: t.rootId, tweets: t.tweets, status: "active" as const })),
    new Set(),
  );
  return new Map(items.map((item) => [item.id, extractMedia(item.text).videos]));
}

/**
 * Fills the mp4 url into bare `[영상]` markers already stored in reviewed text.
 *
 * `x:video-backfill` fills `videoUrl` on the *collected* `x_threads` rows. This is the other half.
 * Translations and renderings saved before that capture existed carry a url-less `[영상]` in their
 * own stored text, and **nothing re-derives stored text on read** — the invariant this whole file
 * hangs off, stated in `sourceMedia.ts` and relied on by `normalizePhotoMarkers` before it. So those
 * markers stay bare forever no matter how completely the collected side has been filled, and a bare
 * marker is not cosmetic: `SendChannels` uploads only the video urls that are non-empty, so the clip
 * a human approved is silently not attached.
 *
 * Reads `x_threads` and never writes it. Writes only `translations.source_text`,
 * `translations.korean_text` and `renderings.text`, through the same `TranslationStore` /
 * `FormattingStore` upserts every other use case here goes through — those upserts are single
 * `insert … on conflict` statements that leave `ordinal` alone, so a fill can never reorder the
 * review screens, and hand-written SQL would have to re-derive rules those stores already own.
 */
export class BackfillTextVideoUrls {
  constructor(
    private readonly threads: CollectionRepository,
    private readonly translations: TranslationStore,
    private readonly renderings: FormattingStore,
  ) {}

  async plan(): Promise<TextVideoBackfillPlan> {
    const urlsByItem = videoUrlsByItem(await this.threads.loadAll());

    const skipped: SkippedText[] = [];
    let scanned = 0;
    let filled = 0;

    /**
     * One text's outcome. Returns the rewritten text, or `undefined` when there is nothing to do or
     * nothing safe to do — pushing the skip itself, so every caller reports on the same terms.
     */
    const fill = (
      itemId: string,
      column: TextColumn,
      text: string,
      // Narrow on purpose: the rest of a skip is this function's to decide, and a caller that could
      // pass `bare` or `reason` could report a refusal that never happened.
      rest: Pick<SkippedText, "type" | "channel">,
    ): string | undefined => {
      const urls = urlsByItem.get(itemId);
      if (urls === undefined) {
        // No thread, so no urls to count against. Still worth a line if the text has a bare marker:
        // a person may have to chase it (a Lark item, or a collected row that has since gone).
        const { bare } = countVideoMarkers(text);
        if (bare === 0) return undefined;
        scanned++;
        skipped.push({ itemId, column, ...rest, bare, reason: { kind: "no-thread" } });
        return undefined;
      }

      const result = fillVideoMarkers(text, urls);
      if (result.status === "no-bare-markers") return undefined;
      scanned++;
      if (result.status === "count-mismatch") {
        skipped.push({
          itemId,
          column,
          ...rest,
          bare: result.bare,
          reason: { kind: "count-mismatch", markers: result.markers, videos: result.urls },
        });
        return undefined;
      }
      if (result.status === "url-missing") {
        skipped.push({ itemId, column, ...rest, bare: result.bare, reason: { kind: "url-missing", missing: result.missing } });
        return undefined;
      }
      filled += result.filled;
      return result.text;
    };

    const translationPatches: TranslationTextPatch[] = [];
    for (const t of await this.translations.loadAll()) {
      const before = filled;
      const sourceText = fill(t.itemId, "translations.source_text", t.sourceText, {});
      const koreanText = fill(t.itemId, "translations.korean_text", t.koreanText, {});
      const columns: TranslationTextPatch["columns"] = [];
      if (sourceText !== undefined) columns.push("source_text");
      if (koreanText !== undefined) columns.push("korean_text");
      // Only rows that actually change are written. An unchanged row in the write set would be a
      // no-op today, but it would still be an upsert racing whoever is editing it in 1차 검수.
      if (columns.length === 0) continue;
      // Spread the stored row: every column not named above — `status`, `posted_url`, `posted_at`
      // and above all `published_text` — travels back through the upsert holding the value it
      // already had. That is what makes this command's write surface exactly its three columns.
      translationPatches.push({
        translation: { ...t, ...(sourceText !== undefined ? { sourceText } : {}), ...(koreanText !== undefined ? { koreanText } : {}) },
        columns,
        filled: filled - before,
      });
    }

    const renderingPatches: RenderingTextPatch[] = [];
    for (const r of await this.renderings.loadAll()) {
      const before = filled;
      const text = fill(r.itemId, "renderings.text", r.text, { type: r.type, channel: r.channel });
      if (text === undefined) continue;
      renderingPatches.push({ rendering: { ...r, text }, filled: filled - before });
    }

    return { scanned, translations: translationPatches, renderings: renderingPatches, skipped, filled };
  }

  /** Writes the plan. Returns how many rows of each kind were written — an empty plan writes nothing. */
  async apply(plan: TextVideoBackfillPlan): Promise<{ translations: number; renderings: number }> {
    for (const patch of plan.translations) await this.translations.upsert(patch.translation);
    for (const patch of plan.renderings) await this.renderings.upsert(patch.rendering);
    return { translations: plan.translations.length, renderings: plan.renderings.length };
  }
}
