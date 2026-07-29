import { SendChannels, type Recorder, type Archiver } from "../app/SendChannels";
import type { FormattingStore } from "../ports/FormattingStore";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { TranslationStore } from "../ports/TranslationStore";
import type { OutletOverrideStore } from "../ports/OutletOverrideStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { SendableChannel } from "../domain/send/channels";
import { deliveryKey } from "../domain/delivery/models";
import { outletById, deliveredByChannelSender, outletsForChannel } from "../domain/outlet/models";
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
    chatIds: loadChatIds = loadTelegramChatIds,
    xMaxWeighted: loadXMax = loadXMaxWeighted,
    senders: makeSenders = createSenders,
    headroom: makeHeadroomReader = headroomReader,
    recorder: makeRecorder = buildRecorder,
    archiver: makeArchiver = buildArchiver,
  } = deps;

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
   * while a real post sits in it. The original post is NOT removed from the room by any of this: two
   * messages exist afterwards, and the row that survives describes the second one.
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
    if (resend) {
      if (!previous) return { sent: 0, failed: 0, error: `${outlet.label} (${outlet.id}): nothing has been sent to this room yet` };
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
        if (previous) await deliveryLedger.add(previous); // nothing went out — the room is still on its first post
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
        if (previous) await deliveryLedger.add(previous); // nothing went out — the room is still on its first post
        return { sent: 0, failed: result.failed, error: `${outlet.label} (${outlet.id}): ${reason}` };
      }
      return { sent: result.sent, failed: result.failed };
    } catch (err) {
      if (previous) await deliveryLedger.add(previous); // the send threw before reaching the room
      return { sent: 0, failed: 1, error: (err as Error).message };
    }
  };
}
