import type { Channel } from "../models";
import { stripMedia } from "../../media/sourceMedia";
import { X_MAX_WEIGHTED } from "../weightedLength";
import { emitKakaoPaste } from "./kakao";
import { emitPrMail } from "./prMail";
import { emitTelegramBot, emitTelegramPaste } from "./telegram";
import type { Destination, EmitResult } from "./types";
import { emitXPaste, emitXTypefully } from "./x";

export type { Destination, EmitResult, EmitSegment } from "./types";

const EMITTERS: Record<Destination, (canonical: string, xMaxWeighted?: number) => EmitResult> = {
  x_paste: emitXPaste,
  x_typefully: emitXTypefully,
  telegram_paste: emitTelegramPaste,
  telegram_bot: emitTelegramBot,
  kakao_paste: emitKakaoPaste,
  pr_mail: emitPrMail,
};

/**
 * A rendering is already channel-scoped — which channels a type fans out to was decided upstream
 * by DEFAULT_CHANNELS_BY_TYPE — so only these destinations apply to it. A kakao rendering has no
 * meaningful telegram_bot spelling.
 */
export const DESTINATIONS_BY_CHANNEL: Record<Channel, Destination[]> = {
  x: ["x_paste", "x_typefully"],
  telegram: ["telegram_paste", "telegram_bot"],
  kakao: ["kakao_paste"],
  pr_mail: ["pr_mail"],
};

/**
 * Whether any of a channel's destinations actually renders `**bold**`.
 *
 * Only `telegram_bot` does (`**x**` → `<b>x</b>`); every other emitter calls `stripBold`. Kept as a
 * constant rather than probed at runtime so it can be read where no emitter output is at hand —
 * `FormatVariants` uses it to decide whether a channel's stored text should carry bold markers at
 * all. `tests/domain/formatting/channelBold.test.ts` runs the real emitters against it, so a new
 * destination that changes the answer for a channel fails the suite rather than drifting.
 */
export const CHANNEL_RENDERS_BOLD: Record<Channel, boolean> = {
  x: false,
  telegram: true,
  kakao: false,
  pr_mail: false,
};

export function emit(canonical: string, destination: Destination, xMaxWeighted: number = X_MAX_WEIGHTED): EmitResult {
  return EMITTERS[destination](stripMedia(canonical), xMaxWeighted);
}

/** Every destination that applies to `channel`, keyed by destination. */
export function emitAll(canonical: string, channel: Channel, xMaxWeighted: number = X_MAX_WEIGHTED): Partial<Record<Destination, EmitResult>> {
  const out: Partial<Record<Destination, EmitResult>> = {};
  for (const destination of DESTINATIONS_BY_CHANNEL[channel]) {
    out[destination] = emit(canonical, destination, xMaxWeighted);
  }
  return out;
}
