import type { ConversionType } from "../conversion/models";

export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export const ALL_CHANNELS: Channel[] = ["x", "telegram", "kakao", "pr_mail"];

/**
 * Which transports each conversion type goes out over. Not a 1:1 mapping by design — Telegram
 * carries `announcement`, `explainer`, `casual` and `kol`, which are different copy entirely.
 *
 * `announcement` used to be written once and carried by both Telegram and KakaoTalk. It no longer
 * is: a KakaoTalk message is one message capped at 500 characters, so Telegram-length copy arrived
 * folded at roughly twice the limit. `kakao_notice` is that news written for the cap instead, and
 * it is the only type this map sends to `kakao`. Renderings written before the split are left
 * alone — the board draws from stored rows, so an old `(announcement, kakao)` card still shows.
 */
export const DEFAULT_CHANNELS_BY_TYPE: Record<ConversionType, Channel[]> = {
  x: ["x"],
  announcement: ["telegram"],
  kakao_notice: ["kakao"],
  explainer: ["telegram"],
  casual: ["telegram"],
  kol: ["telegram"],
  pr: ["pr_mail"],
};

/** One converted variant formatted for a specific channel. Identity is (itemId, type, channel). */
export interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean; // false = canonical, untouched; true = agent/human edited
  createdAt: string;
  status: "rendered" | "approved"; // §7 second-review approval gate
  approvedAt?: string;
}
