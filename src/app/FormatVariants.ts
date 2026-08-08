import { ALL_TYPES, type ConversionType, type ContentVariant } from "../domain/conversion/models";
import { stripBold, toCanonical } from "../domain/formatting/canonical";
import { CHANNEL_RENDERS_BOLD, emitAll, type Destination, type EmitResult } from "../domain/formatting/emitters";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering } from "../domain/formatting/models";
import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";
import type { ConversionStore } from "../ports/ConversionStore";
import { renderingKey, type FormattingStore } from "../ports/FormattingStore";
import type { TranslationStore } from "../ports/TranslationStore";

export interface FormatSelector {
  ids?: string[];
  types?: ConversionType[];
  channels?: Channel[];
}

export interface FormatOptions {
  /**
   * Format only the (item, type, channel) pairs that have **no rendering at all** yet, and leave
   * every existing one exactly as it is. Default (`false`) rebuilds and overwrites — see `run`.
   *
   * A separate argument rather than another field on `FormatSelector` because that type is shared
   * with `PrepareRefinements`, which does not and cannot honour this: a selector field that one of
   * its two consumers silently ignores is a flag that appears to work and does nothing.
   */
  onlyMissing?: boolean;
}

export interface FormatWarning {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  messages: string[];
}

export interface FormatResult {
  /** The renderings this run wrote. Never the ones it left alone — see `run`. */
  renderings: ChannelRendering[];
  warnings: FormatWarning[];
  /**
   * Item ids this run refused to render because their 1차 translation is `posted` — deduplicated,
   * in selection order, and counted **only where a rendering would otherwise have been written**.
   * Under `--only-missing` a finished item whose cards all still exist is therefore absent from
   * this list: nothing was declined, so there is nothing to report, and the scheduler does not put
   * a line in its run log every 30 minutes about a run in which nothing happened.
   *
   * It exists because the skip below applies to every caller, including the ones an operator is
   * standing in front of. `pnpm format --ids <a posted item>` writes nothing, and a bare
   * `rendered: 0` is indistinguishable from "the selector matched no variant" — the
   * appears-to-work-and-does-nothing shape this module already refuses elsewhere (`--only-missing`
   * with `--refine` throws rather than being quietly ignored). `src/cli/format.ts` prints the
   * count; the web format route hands it back untouched.
   */
  skippedPosted: string[];
}

/**
 * Load the variants matching the selector's types + ids. Shared by the §6 use-cases.
 *
 * Deliberately NOT filtered on `status`. Formatting is mechanical — it renders a variant into each
 * channel's canonical text and nothing leaves the machine — so gating it on a variant approval only
 * bought a second review of copy the reviewer reads again on the outlet board. The one human gate
 * that matters is 2차: `SendChannels` sends only `approved` *renderings*, and `ApproveRendering` is
 * where a variant earns its way into the few-shot corpus.
 */
export async function selectVariants(store: ConversionStore, selector: FormatSelector): Promise<ContentVariant[]> {
  const types = selector.types ?? ALL_TYPES;
  const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
  return (await store.loadAll()).filter((v) => types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)));
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    /**
     * The 1차 rows, read for exactly one question: has this item already gone out? See the `posted`
     * gate in `run`. A store rather than an ad-hoc read, like every other use-case in `src/app/`,
     * so this class still runs against in-memory stores in a unit test and still does no I/O of its
     * own — `PublishTranslations` receives the same port for the same check.
     */
    private readonly translationStore: TranslationStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
  ) {}

  /**
   * Render each selected variant into its channels' canonical text and upsert the result.
   *
   * **By default this overwrites.** Every rendering it emits carries `status: "rendered"`,
   * `refined: false` and text rebuilt from the variant, so a pair that a reviewer edited and
   * approved in 2차 검수 comes back out of here as an unapproved, unedited card. That is deliberate
   * and is what the dashboard's red `[포맷 다시]` button and a hand-run `pnpm format --ids …` are
   * for — the operator is told exactly what is lost and confirms it (`docs/ko/review.md`).
   *
   * `options.onlyMissing` is the mode for callers that are not an operator standing at a
   * confirmation dialog — today, the 30-minute `ConvertTick`. It formats only the pairs with no
   * rendering at all, which is the difference between "the board fills itself" and "the board is
   * wiped twice an hour".
   *
   * Neither mode writes anything for an item whose 1차 translation is `posted` — see the gate below.
   */
  async run(selector: FormatSelector, options: FormatOptions = {}): Promise<FormatResult> {
    const variants = await selectVariants(this.conversionStore, selector);
    // Read once for the whole run, before anything is written — and only in this mode, so the
    // default path costs no extra query. Reading it inside the loop would also be wrong, not just
    // slower: this run's own upserts would start appearing in it.
    const alreadyRendered = options.onlyMissing ? await this.formattingStore.listRenderedKeys() : undefined;
    /**
     * The finished items. Read once for the whole run like the set above, but in **both** modes:
     * this gate is about the item being over, not about which mode is asking.
     *
     * `status === "posted"` and nothing else. `postedUrl` is deliberately not consulted — 되돌리기
     * puts an item back to `translated` while leaving `postedUrl` on the row as the evidence of the
     * disputed match (`createDeps`' `unretireTranslation`, and `SaveTranslation` preserving it), so
     * a gate on `postedUrl` would refuse to re-render exactly the item a reviewer just reopened.
     * An item with no translation row at all is not skipped either: only an explicit `posted` says
     * "this went out", a missing row is an anomaly, and the send path already blocks such a row
     * loudly ("원문 번역을 찾을 수 없습니다", `sendBlock`) rather than silently.
     */
    const posted = new Set(
      (await this.translationStore.loadAll()).filter((t) => t.status === "posted").map((t) => t.itemId),
    );

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    const skippedPosted = new Set<string>();
    for (const v of variants) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      /**
       * **A `posted` item is finished, and nothing here may build cards for it.**
       *
       * Same rule and same reasoning as `PublishTranslations`' own `posted` skip — read that
       * comment; it is not repeated here. What re-processing demotes there is the Drive doc; what
       * it demotes here is the 2차 검수 board. `--only-missing` asks "which (item, type, channel)
       * pairs have no rendering?", and a retired item's pairs answer "all of them" forever, so the
       * 30-minute tick manufactured channel cards for work that went out days ago — as unapproved
       * cards, on the board a reviewer is supposed to be able to clear. Deleting them by hand did
       * not help: the variants remain, so the next tick rebuilt every one. Production on
       * 2026-08-08 was holding three such items — `x:2080608995371597892`,
       * `x:2080661810034917770`, `x:2081711456320655644`.
       *
       * **Every caller gets it, not only `--only-missing`.** Scoping it to the scheduled mode was
       * the other candidate, and it is the weaker one. A bare `pnpm format` is documented
       * (`docs/ko/review.md`) as "rebuild every card" and is what an operator runs after re-saving
       * a conversion; under that scoping it would resurrect every card a human cleanup of those
       * three items had just deleted, so the cleanup would not survive one hand run. `posted`
       * already means terminal for every caller in four other places — `PublishTranslations`,
       * `syncSummary` (`src/status/sync.ts`), `loadPublishState` (`src/app/createDeps.ts`) and the
       * 발행 route — and a fifth that meant it only on a timer is where a rule like this drifts.
       *
       * What that choice costs, stated plainly: `[포맷 다시]` aimed at a published item renders
       * nothing and reports `rendered: 0`, and so does `pnpm format --ids <a posted item>`. That
       * is what `skippedPosted` is for — the run says so rather than returning a silent zero. The
       * way back is the one the Drive path already documents: 되돌리기 returns the item to
       * `translated`, formatting resumes normally from there, and 게시됨으로 retires it again.
       *
       * The check sits **after** the already-rendered skip below, not before it, so "skipped"
       * means a write this run declined rather than merely an item it saw. Both orderings refuse
       * the same writes; only this one keeps the scheduler from reporting a finished item whose
       * cards are all still on the board, every fire, forever.
       */
      const isPosted = posted.has(v.itemId);
      // The same canonical text is stored for every channel on purpose: it is a common starting
      // point that the writer can then refine per channel, which is what per-channel approval is for.
      const canonical = toCanonical(v.convertedText);
      for (const channel of channels) {
        // The skip is per (item, type, channel), not per variant: one `announcement` fans out to
        // telegram and kakao, and a run that skipped the whole variant because telegram was already
        // rendered would leave the kakao card missing for good. The key comes from the port that
        // produced the set — see `renderingKey`'s own comment for what a hand-rolled copy costs.
        if (alreadyRendered?.has(renderingKey({ itemId: v.itemId, type: v.type, channel }))) continue;
        if (isPosted) {
          skippedPosted.add(v.itemId);
          continue;
        }
        /**
         * …with one exception: bold markers are dropped for a channel that cannot render them.
         *
         * The decision belongs here, on the channel axis, and NOT back at the variant: `announcement`
         * feeds telegram *and* kakao, so stripping it one step earlier would take the bold off
         * Telegram too, where it is the whole point of the 공지 title convention.
         *
         * Dropping them rather than carrying them inert matters because this text is what the
         * reviewer reads and edits on the board. On kakao a `**제목**` can never do anything: it is
         * noise to read around, and text copied straight out of the editor pastes the asterisks
         * into the room verbatim.
         */
        const text = CHANNEL_RENDERS_BOLD[channel] ? canonical : stripBold(canonical);
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text, refined: false, createdAt: this.now(), status: "rendered",
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        // Group by message text so destinations that agree (e.g. x_paste and x_typefully today)
        // collapse to one line, while destinations that legitimately disagree (paste counts
        // markup, bot counts visible length) stay distinguishable by name.
        const byMessage = new Map<string, Destination[]>();
        for (const [destination, result] of Object.entries(emitAll(text, channel, this.xMaxWeighted)) as [Destination, EmitResult][]) {
          for (const warning of result.warnings) {
            byMessage.set(warning, [...(byMessage.get(warning) ?? []), destination]);
          }
        }
        const messages = [...byMessage].map(([warning, destinations]) => `${destinations.join(", ")}: ${warning}`);
        if (messages.length > 0) warnings.push({ itemId: v.itemId, type: v.type, channel, messages });
      }
    }
    return { renderings, warnings, skippedPosted: [...skippedPosted] };
  }
}
