import type { Channel } from "../models";
import { emitKakaoPaste } from "./kakao";
import { emitPrMail } from "./prMail";
import { emitTelegramBot, emitTelegramPaste } from "./telegram";
import type { Destination, EmitResult } from "./types";
import { emitXPaste, emitXTypefully } from "./x";

export type { Destination, EmitResult, EmitSegment } from "./types";

const EMITTERS: Record<Destination, (canonical: string) => EmitResult> = {
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

export function emit(canonical: string, destination: Destination): EmitResult {
  return EMITTERS[destination](canonical);
}

/** Every destination that applies to `channel`, keyed by destination. */
export function emitAll(canonical: string, channel: Channel): Partial<Record<Destination, EmitResult>> {
  const out: Partial<Record<Destination, EmitResult>> = {};
  for (const destination of DESTINATIONS_BY_CHANNEL[channel]) {
    out[destination] = emit(canonical, destination);
  }
  return out;
}
