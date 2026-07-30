import type { ChannelRendering } from "../domain/formatting/models";
import type { MatchCandidate } from "../domain/kol/attribution";

/**
 * Narrow approved renderings down to the Telegram-channel copy `bestMatch` can compare a KOL post
 * against. Only `status: "approved"` and `channel: "telegram"` renderings qualify — anything else is
 * either not yet human-approved or was formatted for a different channel entirely. A rendering with
 * empty text is dropped too, since `similarity()` can never score it above 0.
 *
 * Lives here (not inline in the CLI) so it is unit-testable independent of sheet/gateway wiring.
 */
export function telegramMatchCandidates(renderings: ChannelRendering[]): MatchCandidate[] {
  return renderings
    .filter((r) => r.status === "approved" && r.channel === "telegram" && r.text !== "")
    .map((r) => ({ itemId: r.itemId, text: r.text }));
}
