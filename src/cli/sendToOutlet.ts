import { SendChannels, type Recorder, type Archiver } from "../app/SendChannels";
import type { FormattingStore } from "../ports/FormattingStore";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { TranslationStore } from "../ports/TranslationStore";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { DraftLookup } from "../ports/DraftLookup";
import type { SendableChannel } from "../domain/send/channels";
import type { DraftState } from "../domain/send/draftState";
import { awaitingPublish } from "../domain/send/awaitingPublish";
import { deliveryKey, type DeliveryEntry } from "../domain/delivery/models";
import { outletById, deliveredByChannelSender, outletsForChannel, type Outlet } from "../domain/outlet/models";
import { headroomReader } from "./publishHeadroom";
import { createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";
import { buildArchiver } from "./archiver";
import { loadTelegramChatIds, loadXMaxWeighted } from "../config";

const isSendableChannel = (c: string): c is SendableChannel => c === "telegram" || c === "x";

export interface SendToOutletDeps {
  formattingStore: FormattingStore;
  deliveryLedger: DeliveryLedger;
  translationStore: TranslationStore;
  overrideStore: OutletOverrideStore;
  /**
   * Only read to build the publishing-headroom reader (`headroomReader` gates X on BOTH ledgers).
   * `serve.ts` holds one `JsonXArticleLedger` for the whole process — pass that same instance, not a
   * fresh one, or a read here can disagree with what `reconcilePublished` sees (see its own comment).
   */
  articleLedger: Parameters<typeof headroomReader>[2];
  /**
   * Typefully, for the resend guard (`guardQueuedDraft` below).
   *
   * Legitimately absent: a Telegram-only install has no `TYPEFULLY_*` env, and `serve.ts` composes
   * this in its own `try/catch` so a missing key cannot take the dashboard down. Absent means the
   * guard is skipped — safe *there* and only there, because the same missing credentials stop
   * `createSenders` from building an X sender at all, so there is no X post for a resend to
   * duplicate. Anywhere that can send to X, pass this.
   *
   * Hence a REQUIRED key with a nullable value, not an optional key: absent and `undefined` mean
   * very different things here, and only one of them is a decision. A caller that wires up an X
   * sender and simply forgets the lookup would otherwise compile, and silently lose the guard that
   * is the only thing between 재발송 and two live posts on a brand account. Writing
   * `draftLookup: undefined` is cheap; a `?` that hides it is not.
   */
  draftLookup: DraftLookup | undefined;
  chatIds?: () => Record<string, string>;
  xMaxWeighted?: () => number;
  senders?: (targets: SendableChannel[]) => Record<SendableChannel, ChannelSender | undefined>;
  headroom?: typeof headroomReader;
  recorder?: () => Promise<Recorder | undefined>;
  archiver?: () => Promise<Archiver | undefined>;
}

/**
 * Builds the board's per-row [발송]. Pulled out of `serve.ts` so the resend restore below — the
 * invariant a previous PR broke by adding an early return between the ledger `remove` and the
 * restores — is something a test can drive, rather than something only reachable by starting the
 * whole dashboard server.
 *
 * `outletById`, `deliveredByChannelSender`, `deliveryKey`, `outletsForChannel` stay plain imports:
 * they are code constants, not environment or module state, and injecting them would push this list
 * past a dozen params for no test that needs to fake a different outlet catalogue.
 */
export function makeSendToOutlet(deps: SendToOutletDeps): (
  itemId: string,
  type: string,
  outletId: string,
  resend?: boolean,
) => Promise<{ sent: number; failed: number; error?: string }> {
  const {
    formattingStore,
    deliveryLedger,
    translationStore,
    overrideStore,
    articleLedger,
    draftLookup,
    chatIds: loadChatIds = loadTelegramChatIds,
    xMaxWeighted: loadXMax = loadXMaxWeighted,
    senders: makeSenders = createSenders,
    headroom: makeHeadroomReader = headroomReader,
    recorder: makeRecorder = buildRecorder,
    archiver: makeArchiver = buildArchiver,
  } = deps;

  /**
   * The resend's look-before-you-leap. Answers with either a `refusal` to hand straight back to the
   * caller, or `cancelled` — whether it removed the original from Typefully's queue on the way
   * through.
   *
   * `cancelled` is not bookkeeping: it changes what the caller must put back if the send then fails.
   * A restored row still says `status: "sent"` with the draft id in `postId`, and once the draft is
   * cancelled that row describes something that no longer exists — the board paints `예약됨` for it,
   * one of the fifteen monthly publishes stays held by `awaitingPublish`, and the room reads as
   * already-delivered until a reconcile pass retires it (≤2 min under `serve`; never, for a pure CLI
   * run). See where the caller builds `restore`.
   *
   * An X send does not publish when it is made: X refuses to direct-publish a draft containing a
   * URL, so every X post goes out through Typefully's queue a couple of minutes later. Inside that
   * window 재발송 used to schedule a *second* draft while the first was still counting down — and the
   * first one still published. Two live posts on a brand's account, irreversibly, and two of the
   * fifteen monthly publishes for a gate that had counted one.
   *
   * So the resend asks Typefully what became of the original first, through the same `published()`
   * `ReconcilePublished` uses, on the same `awaitingPublish` predicate the board paints `예약됨`
   * from — actor and reporter cannot disagree about whether the original is live:
   *
   * - `published` — refuse, writing the real url/id into the row on the way out so the board stops
   *   showing `예약됨` for a post that is already up.
   * - `gone`      — the draft was deleted and will never publish. Nothing to cancel; proceed.
   * - `scheduled` — cancel it, and proceed only on a confirmed cancel. A cancel that did not take
   *   means the original may still publish, and proceeding is exactly the double post.
   *
   * Anything that throws refuses too. `ReconcilePublished` can treat "unknown" as "ask again later"
   * because waiting costs a stuck row; here the alternative to waiting is publishing twice.
   *
   * EVERY return from here happens BEFORE `deliveryLedger.remove(key)`, so a refusal leaves the
   * ledger exactly as it found it and there is no restore to remember. That ordering is the whole
   * point: PR #89 exists because an early return added between the `remove` and the restores skipped
   * one, and the room read as never-sent. Keep new refusals on this side of the `remove`.
   */
  const guardQueuedDraft = async (
    outlet: Outlet,
    previous: DeliveryEntry,
  ): Promise<{ refusal?: { sent: number; failed: number; error: string }; cancelled: boolean }> => {
    // Telegram publishes immediately, and an X row that already carries its x.com url describes a
    // post that is live rather than a draft in the queue. Neither may cost a Typefully round trip.
    if (!awaitingPublish(previous)) return { cancelled: false };
    if (!draftLookup) return { cancelled: false }; // unconfigured — see `SendToOutletDeps.draftLookup`
    const who = `${outlet.label} (${outlet.id})`;

    let state: DraftState;
    try {
      state = await draftLookup.published(previous.postId);
    } catch {
      return { cancelled: false, refusal: { sent: 0, failed: 0, error: `${who}: 예약했던 원본의 게시 여부를 확인하지 못했습니다 — 이미 게시됐다면 같은 글이 두 번 올라가므로 재발송을 멈췄습니다. 잠시 후 다시 시도하세요` } };
    }

    if (state.state === "published") {
      // Updated in place, not removed and restored: this call is refusing, so the row is not going
      // anywhere — and the operator asked about this room, which is the moment to make it true.
      const url = state.xUrl ?? state.articleUrl;
      const postId = (state.xUrl ? state.xId : state.articleId) ?? previous.postId;
      if (url) await deliveryLedger.add({ ...previous, postId, url });
      const where = url ? ` (${url})` : "";
      return { cancelled: false, refusal: { sent: 0, failed: 0, error: `${who}: 예약했던 원본이 이미 게시됐습니다${where} — 재발송하면 같은 글이 두 번 올라가므로 멈췄습니다. 이 방의 기록은 실제 주소로 갱신했습니다` } };
    }

    if (state.state === "scheduled") {
      let cancelled: boolean;
      try {
        cancelled = await draftLookup.cancel(previous.postId);
      } catch {
        cancelled = false; // a request that never completed is not a draft that was removed
      }
      if (!cancelled) {
        return { cancelled: false, refusal: { sent: 0, failed: 0, error: `${who}: 아직 게시 전인 원본의 예약을 취소하지 못했습니다 — 그대로 재발송하면 예약분까지 함께 게시되므로 멈췄습니다. Typefully 큐에서 초안을 지운 뒤 다시 시도하세요` } };
      }
      return { cancelled: true }; // the queue no longer holds it, and the caller has to say so
    }

    return { cancelled: false }; // `gone` — the draft was already deleted; we removed nothing
  };

  /**
   * The board's per-row [발송]: one item, one type, one room. `SendChannels` is the same use case the
   * CLI runs, narrowed on all three axes — the row the operator clicked must not also push the item's
   * other approved copy, or the same copy into the room next door.
   *
   * Every refusal comes back as `error` rather than as a throw: the dashboard has to name the reason,
   * and "the room has no chat id" is an install state, not a server fault. Naming the room explicitly
   * also lifts `SendChannels`' first-delivery guard, which is correct here — a human clicked it.
   */
  /**
   * `resend` posts to a room the ledger already records as `sent`.
   *
   * The ledger is what makes a send happen at most once, so a re-send has to take that row out of the
   * way first — and put it back if the send then fails, or the room would read as never-delivered
   * while a real post sits in it. A post that already reached the room is NOT removed by any of this:
   * two messages exist afterwards, and the row that survives describes the second one.
   *
   * The one exception is an X post that has not reached the room yet — a Typefully draft still
   * counting down to publish. `guardQueuedDraft` cancels that one, or refuses the resend, because
   * "two messages exist afterwards" is the *acceptable* outcome only when the operator can see the
   * first one and chose to send anyway.
   */
  return async (itemId: string, type: string, outletId: string, resend = false): Promise<{ sent: number; failed: number; error?: string }> => {
    const outlet = outletById(outletId);
    if (!outlet) return { sent: 0, failed: 0, error: `unknown outlet: ${outletId}` };
    if (!deliveredByChannelSender(outlet) || !isSendableChannel(outlet.channel)) {
      return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}) is not posted by a bot — copy the text, paste it, and tick 전달함` };
    }
    const channel = outlet.channel;
    const chatIds = loadChatIds();
    if (outlet.chatIdEnv && !chatIds[outlet.id]) {
      return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}): ${outlet.chatIdEnv} is not set` };
    }

    const key = deliveryKey({ itemId, type, outletId });
    const previous = resend ? (await deliveryLedger.loadAll()).find((e) => deliveryKey(e) === key) : undefined;
    /**
     * The row to put back if nothing reaches the room — set only once the row has actually been
     * removed, so every "nothing went out" path below can restore unconditionally.
     *
     * Usually `previous` verbatim: the room still holds the post that row describes.
     *
     * NOT verbatim when the guard cancelled a queued draft. `previous` then describes a Typefully
     * draft this code has just deleted, and writing it back would claim the room is still waiting on
     * a post that can never arrive — the board paints `예약됨`, `awaitingPublish` keeps one of the
     * fifteen monthly publishes reserved for it, and the room is skipped as already-delivered.
     * `dropped` is the truth and is also what unblocks: it frees the quota slot and the room at once,
     * with no reconcile round trip (a CLI-only install never runs one). It is the same retirement
     * `ReconcilePublished` writes for a draft that vanished, reached by a different route.
     */
    let restore: DeliveryEntry | undefined;
    if (resend) {
      if (!previous) return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}): nothing has been sent to this room yet` };
      // Deliberately before the `remove`, not after it: every refusal this can produce returns with
      // the ledger untouched, so no restore has to be remembered on the way out. See its own comment.
      const guard = await guardQueuedDraft(outlet, previous);
      if (guard.refusal) return guard.refusal;
      restore = guard.cancelled ? { ...previous, status: "dropped" } : previous;
      await deliveryLedger.remove(key);
    }

    try {
      const [record, archive] = await Promise.all([makeRecorder(), makeArchiver()]);
      const result = await new SendChannels(
        formattingStore,
        makeSenders([channel]),
        deliveryLedger,
        // The board paints this row's lock from `sendBlock`; the same store makes this call enforce
        // it, so a row that looks sendable on screen is exactly a row that sends.
        translationStore,
        record,
        archive,
        undefined,
        loadXMax(),
        outletsForChannel,
        chatIds,
        // Without this a forked room receives the *group* text — the wrong copy, irreversibly, since
        // the ledger then records the room as `sent` and a `sent` row can never be unmarked.
        overrideStore,
        makeHeadroomReader([channel], deliveryLedger, articleLedger),
      ).run({ targets: [channel], ids: new Set([itemId]), types: [type], outletIds: [outletId] });

      // A quota refusal is not a plain zero-send: the operator needs to know the account is at its
      // ceiling, not that this row failed to send for some ordinary reason.
      if (result.quotaBlocked) {
        const { needed, available, resetsAt } = result.quotaBlocked;
        const when = resetsAt ? ` (${resetsAt.slice(0, 10)} 리셋)` : "";
        if (restore) await deliveryLedger.add(restore); // nothing went out — see `restore`
        // `available` (remaining − inFlight) can be negative when a stale in-flight row overcounts —
        // clamp only the displayed number; the refusal itself already happened on the raw comparison.
        return { sent: 0, failed: 0, error: `Typefully 월간 발행 쿼터가 부족합니다 — 필요 ${needed}건, 잔여 ${Math.max(0, available)}건${when}` };
      }

      // `sent 0` on its own tells the reviewer nothing, so every zero-send outcome carries a reason.
      // Kept in the same English as the `MarkDelivery` / `SaveOutletOverride` refusals, which surface
      // through the same dashboard error path.
      if (result.sent === 0) {
        const reason =
          // Never "check the server log": a dashboard operator has no terminal open. `failures`
          // carries what the run actually hit (an over-limit segment, a sender's own error), which is
          // the difference between "edit the rendering" and "try again".
          result.failed > 0 ? result.failures.map((f) => f.error).join(" · ") || "the send failed"
          : result.skipped > 0 ? "already delivered to this room"
          : result.unconfigured > 0 ? `${result.unconfiguredEnv.join(", ")} is not set`
          : result.withheld > 0 ? "withheld by the first-delivery guard"
          : "no approved copy to send";
        if (restore) await deliveryLedger.add(restore); // nothing went out — see `restore`
        return { sent: 0, failed: result.failed, error: `${outlet.label} (${outlet.id}): ${reason}` };
      }
      return { sent: result.sent, failed: result.failed };
    } catch (err) {
      if (restore) await deliveryLedger.add(restore); // the send threw before reaching the room — see `restore`
      return { sent: 0, failed: 1, error: (err as Error).message };
    }
  };
}
